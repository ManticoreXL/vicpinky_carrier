import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService } from './fms.service';
import { TaskStatus } from './task.schema';
import { RosService } from '../ros/ros.service';
import { RobotService } from '../fleet/robot.service';
import { TopologyService } from '../fleet/topology.service';
import { RobotDocument, RobotStatus } from '../fleet/robot.schema';
import type { RosMessage } from '../ros/ros.types';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const LOOP_MS          = 2_000;
const ONLINE_MS        = 5_000;
const OFFLINE_AFTER_MS = 20_000; // 느린 로봇 / WiFi 혼잡 대비 20s
const AMCL_TIMEOUT_MS  = 20_000; // nav2 재시작 감지 — amcl_pose 없을 때
const FALL_THRESH_RAD  = Math.PI / 4; // 45° 이상 기울면 전복 판정

// 위치 감지 반경 (노드 위주 경로)
const NODE_PASS_M   = 1.5;  // 중간 노드 통과 감지
const NODE_ARRIVE_M = 0.5;  // 최종 목적지 도착 감지 (action result 백업)

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface TaskManagerAlert {
  id: string;
  type: 'fall' | 'robot_offline' | 'task_failed' | 'assigned' | 'completed' | 'info';
  taskId?: string;
  robotId?: string;
  message: string;
  requiresAction: boolean;
  timestamp: number;
}

interface RobotCache {
  lastSeen:    number;
  batteryPct:  number | null;
  posX:        number | null;
  posY:        number | null;
  yaw:         number | null;
  lastAmclMs:  number | null; // amcl_pose 마지막 수신 시각
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private server: Server | null = null;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;

  // robotId → 현재 활성 taskId
  private readonly activeTasks      = new Map<string, string>();
  // robotId → 홈 위치
  private readonly homePositions    = new Map<string, { x: number; y: number; yaw: number }>();
  // robotId → ROS 상태 캐시
  private readonly robotCache       = new Map<string, RobotCache>();
  // 전복 알림 중복 방지 (30s 쿨다운)
  private readonly lastFallAlert    = new Map<string, number>();
  // robotId → 온라인 여부 (undefined = 미확인)
  private readonly robotOnlineState = new Map<string, boolean>();
  // robotId → 점유 로봇 때문에 정지 중인 2-ahead 노드 ID
  private readonly stoppedForNode   = new Map<string, string>();

  // robotId → 코너 회전 상태
  private readonly rotatingState = new Map<string, {
    nextNodeId: string;
    targetYaw: number;
    phase: 'stopping' | 'rotating'; // stopping: 2s 정지, rotating: 회전 중 (yaw 수렴 대기)
    timer: NodeJS.Timeout;
  }>();

  // 동시 amcl_pose 이벤트로 인한 중복 goal 방지
  private readonly waypointProcessing = new Set<string>();
  private readonly lastSentGoal = new Map<string, { nodeId: string; ts: number }>();

  private static readonly CORNER_WAIT_MS     = 2_000;     // 정지 대기 시간
  private static readonly CORNER_THRESH      = Math.PI / 4; // 45° 이상이면 코너 판정
  private static readonly YAW_CONVERGE_THRESH = 0.15;     // ~8.6° — yaw 수렴 판정
  private static readonly CORNER_SAFETY_MS   = 8_000;     // 회전 최대 허용 시간

  constructor(
    private readonly fmsService:      FmsService,
    private readonly rosService:      RosService,
    private readonly robotService:    RobotService,
    private readonly topologyService: TopologyService,
  ) {}

  // ── 라이프사이클 ─────────────────────────────────────────────────────────

  onModuleInit() {
    this.rosService.onMessage((msg) => this.handleRosMessage(msg));
    this.running = true;
    void this.tick();
    // 서버 재시작 시 기존 진행 중인 태스크 복구 (activeTasks 메모리는 초기화됨)
    void this.recoverActiveTasks();
  }

  private async recoverActiveTasks() {
    try {
      const inProgress = await this.fmsService.getInProgressTasks();
      for (const task of inProgress) {
        const robotId = task.assignedRobotId;
        const taskId  = (task._id as { toString(): string }).toString();
        if (robotId && !this.activeTasks.has(robotId)) {
          // 태스크는 있는데 서버가 재시작되어 activeTasks 잃음 → FAILED 처리
          this.logger.warn(`[복구] 서버 재시작으로 인한 태스크 중단: ${taskId} (${robotId}) → FAILED`);
          await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
          if (this.server) {
            await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, { completedAt: new Date() });
          } else {
            await this.fmsService.setStatusDirect(taskId, TaskStatus.FAILED);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`[복구] 태스크 복구 중 오류: ${String(e)}`);
    }
  }

  onModuleDestroy() {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  setServer(server: Server) {
    this.server = server;
    this.topologyService.setServer(server);
  }

  // ── 외부 API ─────────────────────────────────────────────────────────────

  async enqueue(dto: Parameters<FmsService['createQueued']>[0]) {
    const task = await this.fmsService.createQueued(dto);
    this.server?.emit('fms_task_created', task);
    return task;
  }

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.homePositions.set(robotId, { x, y, yaw });
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── 태스크 취소 + 로봇 즉시 정지 ────────────────────────────────────────
  //
  // fmsService.cancel()은 상태만 변경하므로, 로봇 정지는 여기서 처리한다.

  async cancelTask(taskId: string): Promise<void> {
    if (!this.server) return;

    const task = await this.fmsService.getTask(taskId);
    if (!task) return;
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) return;

    const robotId = task.assignedRobotId;

    if (robotId) {
      // 현재 위치를 새 goal로 덮어써서 nav2의 이전 goal을 즉시 무효화
      const cache = this.robotCache.get(robotId);
      if (cache?.posX != null && cache.posY != null) {
        this.fmsService.publishGoal(robotId, cache.posX, cache.posY, cache.yaw ?? 0);
      }
      // cmd_vel=0 정지 (혹시 nav2가 반응 전에 움직이는 경우 대비)
      for (let i = 0; i < 3; i++) {
        this.fmsService.publishStop(robotId);
      }

      this.activeTasks.delete(robotId);
      const rot = this.rotatingState.get(robotId);
      if (rot) { clearTimeout(rot.timer); this.rotatingState.delete(robotId); }
      this.stoppedForNode.delete(robotId);

      // 3. 로봇 상태 IDLE 복귀
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

      this.emit({
        type: 'info', taskId, robotId,
        message: `${robotId} 태스크 취소 — 현재 위치에서 정지`,
        requiresAction: false,
      });
      this.logger.log(`[취소] ${robotId} 정지 (task: ${taskId})`);
    }

    // 4. DB 상태 FAILED 처리
    await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, {
      completedAt: new Date(),
    });
  }

  // ── 맵 전환 시 태스크·위치·캐시 초기화 ──────────────────────────────────
  //
  // 맵이 바뀌면 기존 pathQueue는 구 맵 노드 ID이므로 무효.
  // 활성 태스크 취소 + robot.location 초기화 + AMCL 위치 캐시 클리어.

  async handleMapChange(robotId: string): Promise<void> {
    const taskId = this.activeTasks.get(robotId);
    if (taskId) {
      this.activeTasks.delete(robotId);
      if (this.server) {
        await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, { completedAt: new Date() });
      } else {
        await this.fmsService.setStatusDirect(taskId, TaskStatus.FAILED);
      }
      this.logger.log(`[맵변경] ${robotId} → 진행 태스크 취소 (${taskId})`);
    }

    await this.robotService.updateLocation(robotId, null);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

    const cache = this.robotCache.get(robotId);
    if (cache) {
      this.robotCache.set(robotId, { ...cache, posX: null, posY: null, yaw: null });
    }

    const rotM = this.rotatingState.get(robotId);
    if (rotM) { clearTimeout(rotM.timer); this.rotatingState.delete(robotId); }
    this.stoppedForNode.delete(robotId);

    // 진행 중인 nav2 주행 중단 (맵 변경으로 이전 goal_pose 무효)
    this.fmsService.publishStop(robotId);

    this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
  }

  // ── 초기위치 설정 + robot.location 즉시 갱신 ─────────────────────────────
  //
  // 프론트에서 우클릭 드래그로 초기위치를 잡으면 호출.
  // AMCL에 pose를 전송하고, 가장 가까운 노드를 찾아 robot.location을 업데이트한다.

  async setInitialPoseAndLocation(
    robotId: string, x: number, y: number, yaw: number, mapId?: string,
  ): Promise<void> {
    this.fmsService.publishInitialPose(robotId, x, y, yaw);

    // mapId가 있으면 해당 맵의 노드만 검색, 없으면 전체 대상
    const nearestId = await this.topologyService.findNearestNodeToPosition(x, y, mapId);
    if (nearestId) {
      await this.robotService.updateLocation(robotId, nearestId);
      this.logger.log(`[초기위치] ${robotId} location → ${nearestId} (${x.toFixed(2)}, ${y.toFixed(2)}) [map=${mapId ?? 'any'}]`);
    } else {
      this.logger.warn(`[초기위치] ${robotId} — 가까운 노드 없음 (map=${mapId ?? 'any'}, x=${x.toFixed(2)}, y=${y.toFixed(2)})`);
    }
  }

  // ── 노드 잠금 + 실시간 우회 재경로 ──────────────────────────────────────
  //
  // 노드를 잠그면 해당 노드를 경유 중인 모든 활성 로봇의 경로를 재계산한다.

  async getLockedNodeIds(): Promise<string[]> {
    return this.topologyService.getAllLockedNodeIds();
  }

  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    await this.topologyService.setNodeLocked(nodeId, isLocked);
    if (!this.server) return;

    // 잠금 상태 브로드캐스트 (프론트 맵 시각화 즉시 업데이트)
    this.server.emit('node_lock_changed', { node_id: nodeId, isLocked });

    if (!isLocked) return; // 잠금 해제 시 재경로 불필요

    // 잠긴 노드를 경유하는 활성 태스크 로봇 재경로
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;

      const pathQueue = task.pathQueue ?? [];
      if (!pathQueue.some(id => id === nodeId)) continue; // 이 노드 미포함

      this.logger.log(`[노드 폐쇄] ${robotId} 재경로 (차단 노드: ${nodeId})`);

      // 현재 위치 기반으로 출발 노드 결정
      const cache = this.robotCache.get(robotId);
      const robot = await this.robotService.findById(robotId);
      const targetNode = await this.topologyService.findNodeById(task.targetNode);
      if (!targetNode) continue;

      let startId: string | null = robot?.location ?? null;
      if (!startId && cache?.posX != null && cache.posY != null) {
        startId = await this.topologyService.findNearestNodeToPosition(
          cache.posX, cache.posY, targetNode.map_id,
        );
      }
      if (!startId || startId === task.targetNode) continue;

      // 잠긴 노드 회피 경로 탐색 (findPath 내부에서 lockedNodes 자동 반영)
      const newRaw = await this.topologyService.findPath(
        startId, task.targetNode, targetNode.map_id,
      );

      if (newRaw.length === 0) {
        this.logger.warn(`[노드 폐쇄] ${robotId}: 우회 경로 없음 — 정지 대기`);
        await this.fmsService.setWaitReason(taskId, `노드 ${nodeId} 폐쇄로 우회 경로 없음`);
        this.fmsService.publishStop(robotId);
        continue;
      }

      const newQueue = newRaw.slice(1); // startId는 현재 위치이므로 제외
      await this.fmsService.updatePathQueue(taskId, newQueue, this.server);

      // 새 첫 노드로 goal_pose 재전송 (이전 goal은 새 goal이 덮어씀)
      await this.sendNodeActionGoal(robotId, newQueue[0]);
      this.logger.log(`[재경로] ${robotId}: ${newQueue.join(',')} (우회)`);
      this.emit({ type: 'info', taskId, robotId, message: `${robotId} 노드 ${nodeId} 우회 재경로`, requiresAction: false });
    }
  }

  // ── ROS 메시지 처리 ─────────────────────────────────────────────────────

  private handleRosMessage(msg: RosMessage) {
    const now = Date.now();

    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch) {
      const id   = botMatch[1];
      const prev = this.robotCache.get(id) ?? { lastSeen: 0, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id  = batMatch[1];
      let pct   = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id       = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos      = poseData?.position;
      const ori      = poseData?.orientation;
      if (pos?.x != null) {
        const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
        let yaw = 0;
        if (ori) {
          yaw = Math.atan2(2 * ((ori.w ?? 1) * (ori.z ?? 0) + (ori.x ?? 0) * (ori.y ?? 0)), 1 - 2 * ((ori.y ?? 0) ** 2 + (ori.z ?? 0) ** 2));
        }
        this.robotCache.set(id, { ...prev, posX: pos.x, posY: pos.y ?? 0, yaw, lastAmclMs: now });

        // 코너 회전 중인 경우: yaw 수렴 여부 확인
        const rotState = this.rotatingState.get(id);
        if (rotState?.phase === 'rotating') {
          let yawDiff = yaw - rotState.targetYaw;
          while (yawDiff >  Math.PI) yawDiff -= 2 * Math.PI;
          while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
          if (Math.abs(yawDiff) < TaskManagerService.YAW_CONVERGE_THRESH) {
            clearTimeout(rotState.timer);
            this.rotatingState.delete(id);
            this.logger.log(`[코너] ${id} yaw 수렴 (${(yaw * 180 / Math.PI).toFixed(0)}°) → ${rotState.nextNodeId} 진행`);
            void this.sendNodeActionGoal(id, rotState.nextNodeId);
          }
          return; // 회전 중에는 checkWaypointArrival 스킵
        }

        void this.checkWaypointArrival(id, pos.x, pos.y ?? 0, yaw);
      }
    }

    // IMU — 전복 감지 (roll/pitch > FALL_THRESH_RAD)
    const imuMatch = msg.topic.match(/^\/([^/]+)\/imu$/);
    if (imuMatch) {
      const id  = imuMatch[1];
      const ori = (msg.data as { orientation?: { x?: number; y?: number; z?: number; w?: number } })?.orientation;
      if (ori) {
        const x = ori.x ?? 0, y = ori.y ?? 0, z = ori.z ?? 0, w = ori.w ?? 1;
        const roll  = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
        const sinp  = 2 * (w * y - z * x);
        const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
        if (Math.abs(roll) > FALL_THRESH_RAD || Math.abs(pitch) > FALL_THRESH_RAD) {
          const last = this.lastFallAlert.get(id) ?? 0;
          if (now - last > 30_000) {
            this.lastFallAlert.set(id, now);

            // 상태 ERROR 전환 + DB 저장 + 프론트 브로드캐스트
            void this.robotService.updateStatus(id, RobotStatus.ERROR);
            this.server?.emit('robot_status_changed', { robot_id: id, status: RobotStatus.ERROR });

            this.emit({
              type: 'fall', robotId: id,
              message: `${id} 전복 감지 — roll ${(roll * 180 / Math.PI).toFixed(0)}° / pitch ${(pitch * 180 / Math.PI).toFixed(0)}° → 상태 ERROR`,
              requiresAction: true,
            });
          }
        } else {
          // 자세 정상 복귀 시 ERROR → IDLE 자동 해제
          void this.robotService.findById(id).then(robot => {
            if (robot?.status === RobotStatus.ERROR) {
              void this.robotService.updateStatus(id, RobotStatus.IDLE);
              this.server?.emit('robot_status_changed', { robot_id: id, status: RobotStatus.IDLE });
              this.lastFallAlert.delete(id);
            }
          });
        }
      }
    }
  }

  // ── 중간 웨이포인트 보간 ─────────────────────────────────────────────────
  // 노드 간 0.5m 간격의 좌표 웨이포인트를 삽입해 엣지를 정확히 따라가게 함

  // ── 경유 노드 통과 감지 (위치 추적 전용) ────────────────────────────────

  // ── AMCL 타임아웃 감지 (nav2 재시작) ────────────────────────────────────
  //
  // amcl_pose가 AMCL_TIMEOUT_MS 이상 안 오면 nav2가 꺼진 것으로 판단.
  // 활성 태스크를 FAILED 처리하고 로봇을 IDLE로 복귀.

  private async checkAmclTimeout() {
    if (!this.server) return;
    const now = Date.now();

    for (const [robotId, taskId] of this.activeTasks) {
      const cache = this.robotCache.get(robotId);
      if (!cache || cache.lastAmclMs == null) continue; // 한 번도 amcl 못 받은 로봇은 스킵

      if (now - cache.lastAmclMs < AMCL_TIMEOUT_MS) continue;

      this.logger.warn(`[AMCL타임아웃] ${robotId} — ${AMCL_TIMEOUT_MS / 1000}s간 amcl_pose 없음 → nav2 재시작 추정, 태스크 FAILED`);

      this.activeTasks.delete(robotId);
      const rotA = this.rotatingState.get(robotId);
      if (rotA) { clearTimeout(rotA.timer); this.rotatingState.delete(robotId); }
      this.stoppedForNode.delete(robotId);

      const task = await this.fmsService.getTask(taskId);
      if (task && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, { completedAt: new Date() });
      }
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

      this.emit({
        type: 'info', taskId, robotId,
        message: `${robotId} nav2 재시작 감지 — 태스크 취소, 재포징 후 재시작 필요`,
        requiresAction: true,
      });
      this.server.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    }
  }

  // ── 2-ahead 노드 충돌 감지 ──────────────────────────────────────────────
  //
  // 매 tick마다 실행. 활성 로봇의 pathQueue[1](2노드 앞)에 다른 로봇이 있으면
  // 해당 로봇을 정지시키고, 비워지면 재출발.

  private async checkNodeConflicts() {
    if (!this.server) return;

    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;

      const pathQueue = task.pathQueue ?? [];
      const myCache   = this.robotCache.get(robotId);
      const myPos     = myCache?.posX != null ? `(${myCache.posX.toFixed(2)},${(myCache.posY ?? 0).toFixed(2)})` : 'N/A';

      if (pathQueue.length < 2) {
        if (this.stoppedForNode.has(robotId)) {
          this.logger.log(`[충돌체크] ${robotId} pathQueue<2, 대기 해제 → 재출발 queue=[${pathQueue.join(',')}]`);
          this.stoppedForNode.delete(robotId);
          if (pathQueue.length > 0) await this.sendNodeActionGoal(robotId, pathQueue[0]);
        }
        continue;
      }

      const twoAheadId   = pathQueue[1];
      const twoAheadNode = await this.topologyService.findNodeById(twoAheadId);

      // 다른 활성 로봇 중 twoAheadId를 실제로 점유 중인 로봇 탐색
      let blockerId: string | null = null;
      const distLogs: string[] = [];
      if (twoAheadNode) {
        for (const [otherId] of this.activeTasks) {
          if (otherId === robotId) continue;
          const otherCache = this.robotCache.get(otherId);
          if (!otherCache?.posX) {
            distLogs.push(`${otherId}=noAMCL`);
            continue;
          }
          const dist = Math.hypot(otherCache.posX - twoAheadNode.x, (otherCache.posY ?? 0) - twoAheadNode.y);
          distLogs.push(`${otherId}=${dist.toFixed(2)}m`);
          if (dist < NODE_PASS_M) { blockerId = otherId; break; }
        }
      } else {
        distLogs.push(`twoAheadNode="${twoAheadId}" DB없음`);
      }

      this.logger.log(
        `[충돌체크] ${robotId} pos=${myPos} queue=[${pathQueue.join(',')}] 2ahead=${twoAheadId}` +
        ` | ${distLogs.join(', ')}` +
        (this.stoppedForNode.has(robotId) ? ` | 현재정지중(${this.stoppedForNode.get(robotId)})` : ''),
      );

      if (blockerId) {
        if (!this.stoppedForNode.has(robotId)) {
          this.logger.log(`[대기] ${robotId} 정지 — ${twoAheadId} 점유 중 (${blockerId})`);
          this.fmsService.publishStop(robotId);
          this.stoppedForNode.set(robotId, twoAheadId);
        }
      } else if (this.stoppedForNode.get(robotId) === twoAheadId) {
        this.logger.log(`[재출발] ${robotId} — ${twoAheadId} 비워짐, 경로 재개`);
        this.stoppedForNode.delete(robotId);
        await this.sendNodeActionGoal(robotId, pathQueue[0]);
      }
    }
  }

  private async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number) {
    if (this.waypointProcessing.has(robotId)) return; // amcl_pose 연속 수신 시 중복 실행 방지
    if (this.rotatingState.has(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 코너 회전 중 (phase=${this.rotatingState.get(robotId)?.phase})`);
      return;
    }
    if (this.stoppedForNode.has(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 충돌 대기 중 (node=${this.stoppedForNode.get(robotId)})`);
      return;
    }
    this.waypointProcessing.add(robotId);
    try {
      const taskId = this.activeTasks.get(robotId);
      if (!taskId || !this.server) return;

      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.logger.log(`[웨이포인트] ${robotId} 태스크 ${taskId} 이미 종료(${task?.status}) — activeTasks 제거`);
        this.activeTasks.delete(robotId);
        return;
      }

      const remaining = [...(task.pathQueue ?? [])];
      if (remaining.length === 0) return;

      const nextId = remaining[0];
      const node = await this.topologyService.findNodeById(nextId);
      if (!node) return;

      const isFinal   = remaining.length === 1;
      const threshold = isFinal ? NODE_ARRIVE_M : NODE_PASS_M;
      const dist      = Math.hypot(x - node.x, y - node.y);

      this.logger.log(
        `[웨이포인트] ${robotId} pos=(${x.toFixed(2)},${y.toFixed(2)}) → next=${nextId}` +
        ` dist=${dist.toFixed(2)}m threshold=${threshold}m${isFinal ? ' [최종]' : ''}` +
        ` queue=[${remaining.join(',')}]`,
      );

      if (dist > threshold) return;

      await this.robotService.updateLocation(robotId, nextId);

      if (isFinal) {
        this.activeTasks.delete(robotId);

        await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
          completedAt: new Date(),
          assignedRobotId: robotId,
        });
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
        this.emit({ type: 'completed', taskId, robotId, message: `${robotId} 태스크 완료 (${task.targetNode})`, requiresAction: false });
        this.fmsService.publishInitialPose(robotId, x, y, yaw);
        this.returnHome(robotId);
        return;
      }

      remaining.shift();
      await this.fmsService.updatePathQueue(taskId, remaining, this.server);

      if (remaining.length > 0) {
        const nextNodeId = remaining[0];
        const nextNode   = await this.topologyService.findNodeById(nextNodeId);
        if (nextNode) {
          const outYaw   = Math.atan2(nextNode.y - node.y, nextNode.x - node.x);
          let   diff     = outYaw - yaw;
          while (diff >  Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (Math.abs(diff) > TaskManagerService.CORNER_THRESH) {
            this.logger.log(`[코너] ${robotId} @ ${nextId}: ${(Math.abs(diff) * 180 / Math.PI).toFixed(0)}° 회전 필요 — 2s 정지 후 회전 → ${nextNodeId}`);

            // Phase 1: 2초 정지
            for (let i = 0; i < 3; i++) this.fmsService.publishStop(robotId);

            const stopTimer = setTimeout(() => {
              // Phase 2: 회전 goal 전송 (현재 위치에서 outYaw 방향으로 in-place 회전)
              this.fmsService.publishGoal(robotId, node.x, node.y, outYaw);
              this.logger.log(`[코너] ${robotId} 회전 시작 → ${(outYaw * 180 / Math.PI).toFixed(0)}° (${nextNodeId})`);

              // 안전 타임아웃: 회전이 CORNER_SAFETY_MS 이상 걸리면 강제 진행
              const safetyTimer = setTimeout(() => {
                const s = this.rotatingState.get(robotId);
                if (s?.nextNodeId === nextNodeId) {
                  this.logger.warn(`[코너] ${robotId} 회전 타임아웃 — 강제 진행 → ${nextNodeId}`);
                  this.rotatingState.delete(robotId);
                  void this.sendNodeActionGoal(robotId, nextNodeId);
                }
              }, TaskManagerService.CORNER_SAFETY_MS);

              this.rotatingState.set(robotId, { nextNodeId, targetYaw: outYaw, phase: 'rotating', timer: safetyTimer });
            }, TaskManagerService.CORNER_WAIT_MS);

            this.rotatingState.set(robotId, { nextNodeId, targetYaw: outYaw, phase: 'stopping', timer: stopTimer });
            return;
          }
        }
        await this.sendNodeActionGoal(robotId, nextNodeId);
      }
    } finally {
      this.waypointProcessing.delete(robotId);
    }
  }

  // ── 메인 처리 루프 ───────────────────────────────────────────────────────

  private async tick() {
    if (!this.running) return;
    try {
      await this.syncOnlineStatus();
      await this.checkAmclTimeout();
      await this.process();
      await this.checkNodeConflicts();
    } catch (e) { this.logger.error('루프 오류', e); }
    this.loopTimer = setTimeout(() => void this.tick(), LOOP_MS);
  }

  private async syncOnlineStatus() {
    const now = Date.now();
    for (const [robotId, cache] of this.robotCache.entries()) {
      const isNowOnline = now - cache.lastSeen < OFFLINE_AFTER_MS;
      const wasOnline   = this.robotOnlineState.get(robotId);

      if (isNowOnline && wasOnline !== true) {
        this.robotOnlineState.set(robotId, true);
        await this.robotService.bringOnlineIfOffline(robotId);
        // 실제 DB 상태를 읽어서 emit (hardcode IDLE 방지 → MOVING 중이면 MOVING 유지)
        const actualRobot = await this.robotService.findById(robotId);
        const actualStatus = actualRobot?.status ?? 'IDLE';
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: actualStatus });

      } else if (!isNowOnline && wasOnline !== false) {
        this.robotOnlineState.set(robotId, false);

        // MOVING 상태에서 강제 종료 시에도 OFFLINE 처리 (기존 setOfflineIfIdle 대체)
        await this.robotService.setOffline(robotId);
        await this.robotService.updateLocation(robotId, null); // 오프라인 시 위치 초기화

        // 진행 중이던 태스크/nav action 정리
        const activeTaskId = this.activeTasks.get(robotId);
        if (activeTaskId) {
          this.activeTasks.delete(robotId);

          // 태스크 FAILED 처리 (서버가 살아있는 경우)
          if (this.server) {
            await this.fmsService.setStatus(activeTaskId, TaskStatus.FAILED, this.server, {
              completedAt: new Date(),
            });
          }
        }

        this.emit({ type: 'robot_offline', robotId, message: `${robotId} 오프라인 (태스크 중단)`, requiresAction: true });
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'OFFLINE' });
      }
    }
  }

  private async process() {
    if (!this.server) return;

    // 1. 완료/실패 태스크 → 로봇·엣지 해제
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.activeTasks.delete(robotId); continue; }
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.activeTasks.delete(robotId);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      }
    }

    // 1b. MOVING 상태이지만 activeTasks에 없는 로봇 → 자동 IDLE 복구
    for (const [robotId, cache] of this.robotCache.entries()) {
      if (this.activeTasks.has(robotId)) continue;
      if ((Date.now() - cache.lastSeen) >= ONLINE_MS) continue;
      const robot = await this.robotService.findById(robotId);
      if (robot?.status === RobotStatus.MOVING) {
        this.logger.warn(`[복구] ${robotId} — MOVING이지만 활성 태스크 없음 → IDLE 강제 복귀`);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
      }
    }

    // 2. PENDING 태스크 탐색
    const pending = await this.fmsService.getPendingTasks(20);
    if (!pending.length) return;

    // 3. 가용 IDLE 로봇
    const now2 = Date.now();
    const freeRobots: RobotDocument[] = [];
    for (const [robotId, cache] of this.robotCache.entries()) {
      const age = now2 - cache.lastSeen;
      if (age >= ONLINE_MS) continue;
      if (this.activeTasks.has(robotId)) continue;
      const robot = await this.robotService.autoRegister(robotId);
      if (robot.status === RobotStatus.IDLE) freeRobots.push(robot);
    }
    if (!freeRobots.length) return;

    for (const task of pending) {
      if (!freeRobots.length) break;
      const taskId = (task._id as { toString(): string }).toString();

      // 지정 로봇이 있으면 그 로봇만 사용, 없으면 임의 배정
      let robot: RobotDocument;
      const preferredId = task.preferredRobotId;
      if (preferredId) {
        const idx = freeRobots.findIndex((r) => r.robot_id === preferredId);
        if (idx === -1) {
          await this.fmsService.setWaitReason(taskId, `지정 로봇 ${preferredId} 대기 중`);
          continue;
        }
        robot = freeRobots.splice(idx, 1)[0];
      } else {
        robot = freeRobots.shift()!;
      }

      const robotId = robot.robot_id;

      // 온라인 확인
      const cache  = this.robotCache.get(robotId);
      const online = cache && (Date.now() - cache.lastSeen) < ONLINE_MS;
      if (!online) {
        this.logger.warn(`[dispatch] ${robotId} 오프라인 — 건너뜀`);
        await this.fmsService.setWaitReason(taskId, '로봇 오프라인 — 재연결 대기');
        freeRobots.unshift(robot);
        continue;
      }

      this.logger.log(
        `[dispatch] ${robotId} 태스크 ${taskId} 배정 시작` +
        ` | location=${robot.location ?? 'null'}` +
        ` | AMCL pos=${cache?.posX != null ? `(${cache.posX.toFixed(2)},${(cache.posY ?? 0).toFixed(2)})` : 'N/A'}` +
        ` | target=${task.targetNode}`,
      );

      // ── 경로 탐색 ─────────────────────────────────────────────────────────
      let pathQueue: string[] = [];

      // 목적지 노드 확인 (map_id 결정에 필요)
      const targetNode = await this.topologyService.findNodeById(task.targetNode);
      if (!targetNode) {
        this.logger.warn(`[dispatch] 목적지 노드 "${task.targetNode}"가 DB에 없음`);
        await this.fmsService.setWaitReason(taskId, `목적지 노드 없음: ${task.targetNode}`);
        await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
        continue;
      }
      const myMapId = targetNode.map_id;

      // 출발 노드 결정: robot.location이 현재 맵의 실제 노드인지 검증
      let startNodeId: string | null = null;

      if (robot.location && robot.location !== task.targetNode) {
        const locNode = await this.topologyService.findNodeById(robot.location);
        if (locNode && locNode.map_id === myMapId) {
          // robot.location이 같은 맵의 유효한 노드
          startNodeId = robot.location;
        }
      }

      // AMCL 캐시로 최근접 노드 탐색 (robot.location 무효 또는 null인 경우)
      if (!startNodeId) {
        const cache2 = this.robotCache.get(robotId);
        if (cache2?.posX != null && cache2.posY != null) {
          startNodeId = await this.topologyService.findNearestNodeToPosition(
            cache2.posX, cache2.posY, myMapId,
          );
          if (startNodeId) {
            await this.robotService.updateLocation(robotId, startNodeId);
          }
        }
      }

      if (!startNodeId || startNodeId === task.targetNode) {
        // 출발 노드가 없거나 이미 목적지
        this.logger.log(`[dispatch] ${robotId} startNode=${startNodeId ?? 'null'} — 목적지 직행 [${task.targetNode}]`);
        pathQueue = [task.targetNode];
      } else {
        const rawPath = await this.topologyService.findPath(startNodeId, task.targetNode, myMapId);
        if (rawPath.length === 0) {
          this.logger.warn(`[dispatch] 경로 없음: ${startNodeId} → ${task.targetNode} (${robotId})`);
          await this.fmsService.setWaitReason(taskId, `경로 없음: ${startNodeId} → ${task.targetNode}`);
          this.emit({ type: 'task_failed', taskId, robotId, message: `경로를 찾을 수 없음: ${startNodeId} → ${task.targetNode}`, requiresAction: false });
          await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
          continue;
        }
        pathQueue = rawPath.slice(1);
        this.logger.log(`[dispatch] ${robotId} 경로 확정: ${startNodeId} → ${task.targetNode} = [${pathQueue.join('→')}]`);
      }

      this.activeTasks.set(robotId, taskId);

      await this.fmsService.assignToRobot(taskId, robotId, pathQueue, this.server!);
      await this.robotService.updateStatus(robotId, RobotStatus.MOVING);

      const firstGoalId = pathQueue[0] ?? task.targetNode;
      await this.sendNodeActionGoal(robotId, firstGoalId);

      this.emit({
        type: 'assigned', taskId, robotId,
        message: `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당 — 경로: [${pathQueue.join('→')}]`,
        requiresAction: false,
      });
    }
  }

  // ── 노드 단위 goal_pose 토픽 전송 ──────────────────────────────────────
  // domain_bridge: /{robotId}/goal_pose (domain40) → /goal_pose (robot domain)
  // 도착 감지: checkWaypointArrival (amcl_pose 위치 기반)
  //
  private async sendNodeActionGoal(
    robotId: string,
    nodeId: string,
  ): Promise<void> {
    const last = this.lastSentGoal.get(robotId);
    if (last?.nodeId === nodeId && Date.now() - last.ts < 300) {
      this.logger.debug(`[sendNodeGoal] ${robotId} → ${nodeId} 중복 스킵 (${Date.now() - last.ts}ms)`);
      return;
    }
    this.lastSentGoal.set(robotId, { nodeId, ts: Date.now() });

    const node = await this.topologyService.findNodeById(nodeId);
    if (!node) {
      this.logger.warn(`[sendNodeGoal] 노드 "${nodeId}" DB에 없음`);
      return;
    }

    const yaw = node.yaw ?? 0;
    this.fmsService.publishGoal(robotId, node.x, node.y, yaw);
    this.logger.log(`[goal_pose] ${robotId} → ${nodeId} (${node.x.toFixed(2)}, ${node.y.toFixed(2)}) yaw=${(yaw * 180 / Math.PI).toFixed(0)}°`);
  }

  // ── 헬퍼 ─────────────────────────────────────────────────────────────────

  private returnHome(robotId: string) {
    const home = this.homePositions.get(robotId);
    if (!home) return;
    this.fmsService.publishGoal(robotId, home.x, home.y, home.yaw);
    this.emit({ type: 'info', robotId, message: `${robotId} 홈 복귀 중`, requiresAction: false });
  }

  private emit(alert: Omit<TaskManagerAlert, 'id' | 'timestamp'>) {
    if (!this.server) return;
    const full: TaskManagerAlert = {
      ...alert,
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.server.emit('task_manager_alert', full);
    this.logger.log(`[TM] ${full.message}`);
  }
}
