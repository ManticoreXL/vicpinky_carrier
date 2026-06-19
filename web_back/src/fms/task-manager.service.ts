import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService } from './fms.service';
import { TaskStatus, TaskType } from './task.schema';
import { RosService } from '../ros/ros.service';
import { RobotService } from '../fleet/robot.service';
import { TopologyService } from '../fleet/topology.service';
import { TelemetryService } from '../fleet/telemetry.service';
import { CollisionAvoidanceService } from '../fleet/collision-avoidance.service';
import { RobotDocument, RobotStatus } from '../fleet/robot.schema';
import type { RosMessage } from '../ros/ros.types';
import {
  LOOP_MS, ONLINE_MS, OFFLINE_AFTER_MS, AMCL_TIMEOUT_MS,
  FALL_THRESH_RAD, NODE_PASS_M, NODE_ARRIVE_M,
} from './task-manager.constants';
import { TaskManagerAlert, RobotCache } from './task-manager.types';
import { normalizeAngle, quatToYaw, emptyCache } from './task-manager.helpers';
import { resolveDispatchPath, DispatchCtx } from './task-manager.dispatch';

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private server: Server | null = null;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now(); // 부팅 직후 온라인 로봇이 첫 메시지를 보낼 유예 시간 계산용

  // robotId → 현재 활성 taskId
  private readonly activeTasks      = new Map<string, string>();
  // robotId → 홈 위치
  private readonly homePositions    = new Map<string, { x: number; y: number; yaw: number }>();
  // robotId → ROS 상태 캐시
  private readonly robotCache       = new Map<string, RobotCache>();
  // 전복 알림 중복 방지 (30s 쿨다운)
  private readonly lastFallAlert    = new Map<string, number>();
  // robotId → 전복으로 장애 잠금한 노드 ID (자세 복귀 시 자동 해제용)
  private readonly fallLockedNodes  = new Map<string, string>();
  // robotId → 온라인 여부 (undefined = 미확인)
  private readonly robotOnlineState = new Map<string, boolean>();
  // 충돌 회피 정지/재출발 상태는 CollisionAvoidanceService가 소유 (collisionService)
  // AMCL 타임아웃으로 일시정지된 태스크 (복구 시 자동 재개)
  private readonly suspendedTasks   = new Map<string, string>();

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
    private readonly fmsService:       FmsService,
    private readonly rosService:       RosService,
    private readonly robotService:     RobotService,
    private readonly topologyService:  TopologyService,
    private readonly telemetryService: TelemetryService,
    private readonly collisionService: CollisionAvoidanceService,
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

  // 등록만 — DRAFT 상태로 생성 (자동 배차 안 함)
  async register(dto: Parameters<FmsService['createDraft']>[0]) {
    const task = await this.fmsService.createDraft(dto);
    this.server?.emit('fms_task_created', task);
    return task;
  }

  // DRAFT 태스크를 배차 큐(PENDING)에 투입 → 다음 tick에서 자동 배정
  async releaseTask(taskId: string) {
    return this.fmsService.release(taskId, this.server);
  }

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.homePositions.set(robotId, { x, y, yaw });
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── 긴급 정지 (EXAONE 에이전트 / 관제) ────────────────────────────────────
  //
  // 활성 태스크가 있으면 취소(=정지+IDLE), 없으면 단순 cmd_vel 정지.

  async stopRobot(robotId: string): Promise<{ ok: boolean; message: string }> {
    const taskId = this.activeTasks.get(robotId);
    if (taskId) {
      await this.cancelTask(taskId);
      return { ok: true, message: `${robotId} 태스크 취소 및 정지 완료` };
    }
    this.hardStop(robotId);
    this.collisionService.clear(robotId);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
    this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    return { ok: true, message: `${robotId} 정지 완료 (진행 중 태스크 없음)` };
  }

  // ── 홈 복귀 (EXAONE 에이전트 / 관제) ──────────────────────────────────────

  returnHomeNow(robotId: string): { ok: boolean; message: string } {
    const home = this.homePositions.get(robotId);
    if (!home) {
      return { ok: false, message: `${robotId} 홈 위치가 등록되지 않음 — 맵에서 홈을 먼저 지정하세요` };
    }
    this.returnHome(robotId);
    return { ok: true, message: `${robotId} 홈 복귀 시작 (${home.x.toFixed(2)}, ${home.y.toFixed(2)})` };
  }

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
      this.hardStop(robotId);

      this.activeTasks.delete(robotId);
      const rot = this.rotatingState.get(robotId);
      if (rot) { clearTimeout(rot.timer); this.rotatingState.delete(robotId); }
      this.collisionService.clear(robotId);

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
    this.collisionService.clear(robotId);

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
      await this.fmsService.updatePathQueue(taskId, newQueue, this.server, newQueue);

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
      const prev = this.robotCache.get(id) ?? emptyCache(0);
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id  = batMatch[1];
      let pct   = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      const prev = this.robotCache.get(id) ?? emptyCache(now);
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id       = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos      = poseData?.position;
      const ori      = poseData?.orientation;
      if (pos?.x != null) {
        const prev = this.robotCache.get(id) ?? emptyCache(now);
        const yaw = ori ? quatToYaw(ori) : 0;
        this.robotCache.set(id, { ...prev, posX: pos.x, posY: pos.y ?? 0, yaw, lastAmclMs: now });

        // 코너 회전 중인 경우: yaw 수렴 여부 확인
        const rotState = this.rotatingState.get(id);
        if (rotState?.phase === 'rotating') {
          const yawDiff = normalizeAngle(yaw - rotState.targetYaw);
          if (Math.abs(yawDiff) < TaskManagerService.YAW_CONVERGE_THRESH) {
            clearTimeout(rotState.timer);
            this.rotatingState.delete(id);
            this.logger.log(`[코너] ${id} yaw 수렴 (${(yaw * 180 / Math.PI).toFixed(0)}°) → ${rotState.nextNodeId} 진행`);
            void this.sendNodeActionGoal(id, rotState.nextNodeId);
          }
          return; // 회전 중에는 checkWaypointArrival 스킵
        }

        // AMCL 복구 감지: 일시정지 태스크 자동 재개
        if (this.robotCache.get(id)?.amclSuspended) {
          void this.checkAmclResume(id, pos.x, pos.y ?? 0, yaw);
          return;
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

            // AMCL 위치 기준 최근접 노드를 "장애"로 잠금 (전복 지점 봉쇄 + 경유 로봇 자동 우회)
            const cache = this.robotCache.get(id);
            if (cache?.posX != null && cache.posY != null) {
              const px = cache.posX, py = cache.posY;
              void (async () => {
                const nearestNodeId = await this.topologyService.findNearestNodeToPosition(px, py);
                if (!nearestNodeId) return;
                this.fallLockedNodes.set(id, nearestNodeId);
                await this.lockNode(nearestNodeId, true);
                this.logger.warn(`[전복-장애] ${id} 전복 지점 노드 ${nearestNodeId} → 장애 인식, 잠금`);
              })();
            }

            this.emit({
              type: 'fall', robotId: id,
              message: `${id} 전복 감지 — roll ${(roll * 180 / Math.PI).toFixed(0)}° / pitch ${(pitch * 180 / Math.PI).toFixed(0)}° → 상태 ERROR, 전복 지점 노드 장애 잠금`,
              requiresAction: true,
            });
          }
        } else {
          // 자세 정상 복귀 시 로봇 상태(ERROR→IDLE) + 전복 지점 장애 노드 자동 해제
          void this.robotService.findById(id).then(robot => {
            if (robot?.status === RobotStatus.ERROR) {
              void this.robotService.updateStatus(id, RobotStatus.IDLE);
              this.server?.emit('robot_status_changed', { robot_id: id, status: RobotStatus.IDLE });
              this.lastFallAlert.delete(id);
              // 전복으로 장애 잠금했던 노드 해제
              const lockedNodeId = this.fallLockedNodes.get(id);
              if (lockedNodeId) {
                this.fallLockedNodes.delete(id);
                void this.lockNode(lockedNodeId, false);
                this.logger.log(`[전복복구] ${id} 자세 복귀 → 노드 ${lockedNodeId} 장애 잠금 해제`);
              }
            }
          });
        }
      }
    }
  }

  // ── 중간 웨이포인트 보간 ─────────────────────────────────────────────────
  // 노드 간 0.5m 간격의 좌표 웨이포인트를 삽입해 엣지를 정확히 따라가게 함

  // ── 경유 노드 통과 감지 (위치 추적 전용) ────────────────────────────────

  // ── AMCL 타임아웃 감지 (nav2 TF 초기화 / 재시작) ─────────────────────────
  //
  // amcl_pose가 AMCL_TIMEOUT_MS(60s) 이상 안 오면 nav2 초기화 중으로 판단.
  // 태스크를 SUSPENDED로 보류하고 activeTasks에서만 제거 (FAILED 아님).
  // AMCL이 복구되면 자동으로 goal_pose 재전송하고 태스크 재개.

  private async checkAmclTimeout() {
    if (!this.server) return;
    const now = Date.now();

    for (const [robotId, taskId] of this.activeTasks) {
      const cache = this.robotCache.get(robotId);
      if (!cache || cache.lastAmclMs == null) continue;
      if (now - cache.lastAmclMs < AMCL_TIMEOUT_MS) continue;
      if (cache.amclSuspended) continue; // 이미 처리됨

      this.logger.warn(`[AMCL타임아웃] ${robotId} — ${AMCL_TIMEOUT_MS / 1000}s간 amcl_pose 없음 → nav2 초기화 추정, 태스크 일시정지`);

      // activeTasks에서 제거 (중복 goal 방지)
      this.activeTasks.delete(robotId);
      const rotA = this.rotatingState.get(robotId);
      if (rotA) { clearTimeout(rotA.timer); this.rotatingState.delete(robotId); }
      this.collisionService.clear(robotId);

      // 태스크는 SUSPENDED (FAILED 아님) — 복구 후 재개 가능
      const task = await this.fmsService.getTask(taskId);
      if (task && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.fmsService.setWaitReason(taskId, 'Nav2 초기화 중 — AMCL 복구 대기');
        await this.fmsService.setStatus(taskId, TaskStatus.SUSPENDED, this.server);
      }

      // amclSuspended 플래그 + 대기 중인 taskId 기록
      this.robotCache.set(robotId, { ...cache, amclSuspended: true });
      this.suspendedTasks.set(robotId, taskId);

      this.emit({
        type: 'info', taskId, robotId,
        message: `${robotId} Nav2 초기화 감지 — AMCL 복구 시 자동 재개`,
        requiresAction: false,
      });
      this.server.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    }
  }

  // ── AMCL 복구 감지 → 일시정지 태스크 자동 재개 ────────────────────────────

  private async checkAmclResume(robotId: string, x: number, y: number, yaw: number) {
    const cache = this.robotCache.get(robotId);
    if (!cache?.amclSuspended) return;

    const taskId = this.suspendedTasks.get(robotId);
    if (!taskId) { cache.amclSuspended = false; return; }

    const task = await this.fmsService.getTask(taskId);
    if (!task || task.status !== TaskStatus.SUSPENDED) {
      this.suspendedTasks.delete(robotId);
      this.robotCache.set(robotId, { ...cache, amclSuspended: false });
      return;
    }

    this.logger.log(`[AMCL복구] ${robotId} — AMCL 재수신, 태스크 ${taskId} 재개`);

    // 초기 위치 재설정 (AMCL 안정화 지원)
    this.fmsService.publishInitialPose(robotId, x, y, yaw);

    // 잠깐 대기 후 goal_pose 재전송
    await new Promise(r => setTimeout(r, 2000));

    const freshTask = await this.fmsService.getTask(taskId);
    if (!freshTask || freshTask.status !== TaskStatus.SUSPENDED) return;

    const nextNodeId = (freshTask.pathQueue ?? [])[0] ?? freshTask.targetNode;
    const nextNode   = await this.topologyService.findNodeById(nextNodeId);
    if (!nextNode) {
      this.logger.warn(`[AMCL복구] ${robotId} 다음 노드 "${nextNodeId}" 없음 — FAILED`);
      await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!, { completedAt: new Date() });
      this.suspendedTasks.delete(robotId);
      this.robotCache.set(robotId, { ...cache, amclSuspended: false });
      return;
    }

    // 태스크 RUNNING 복귀 + activeTasks 재등록
    await this.fmsService.setStatus(taskId, TaskStatus.RUNNING, this.server!);
    this.activeTasks.set(robotId, taskId);
    this.suspendedTasks.delete(robotId);
    this.robotCache.set(robotId, { ...cache, amclSuspended: false });

    await this.sendNodeActionGoal(robotId, nextNodeId);
    this.emit({
      type: 'info', taskId, robotId,
      message: `${robotId} AMCL 복구 — 태스크 재개: ${nextNodeId}`,
      requiresAction: false,
    });
  }

  // ── 2-ahead 노드 충돌 감지 (CollisionAvoidanceService 위임) ──────────────
  //
  // 매 tick마다 실행. 충돌 판정 로직은 CollisionAvoidanceService가 담당하고,
  // 여기서는 활성 로봇의 현재 상태를 모아 넘긴 뒤, 반환된 결정(정지/재출발)에 따라
  // 실제 cmd_vel 정지 / goal_pose 재전송 부수효과만 수행한다.

  private async checkNodeConflicts() {
    if (!this.server) return;

    // 1. 활성 로봇의 경로 + 현재 위치 수집
    const states: { robotId: string; pathQueue: string[]; posX: number | null; posY: number | null }[] = [];
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;
      const cache = this.robotCache.get(robotId);
      states.push({
        robotId,
        pathQueue: task.pathQueue ?? [],
        posX: cache?.posX ?? null,
        posY: cache?.posY ?? null,
      });
    }
    if (states.length === 0) return;

    // 2. 충돌 평가 → 결정 목록
    const decisions = await this.collisionService.evaluate(states);

    // 3. 결정 적용
    for (const d of decisions) {
      if (d.action === 'stop') {
        this.fmsService.publishStop(d.robotId);
        this.emit({
          type: 'info', robotId: d.robotId,
          message: `${d.robotId} 정지 — ${d.conflictNode} 점유 중 (${d.blockerId})`,
          requiresAction: false,
        });
      } else {
        // resume — 현재 남은 경로의 첫 노드로 재출발
        const st = states.find(s => s.robotId === d.robotId);
        if (st && st.pathQueue.length > 0) {
          await this.sendNodeActionGoal(d.robotId, st.pathQueue[0]);
        }
      }
    }
  }

  private async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number) {
    if (this.waypointProcessing.has(robotId)) return; // amcl_pose 연속 수신 시 중복 실행 방지
    if (this.rotatingState.has(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 코너 회전 중 (phase=${this.rotatingState.get(robotId)?.phase})`);
      return;
    }
    if (this.collisionService.isWaiting(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 충돌 대기 중 (node=${this.collisionService.getBlockedNode(robotId)})`);
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
      if (!node) {
        this.logger.warn(`[웨이포인트] ${robotId} 다음 노드 "${nextId}" DB에 없음 — 큐에서 제거 후 재시도`);
        remaining.shift();
        await this.fmsService.updatePathQueue(taskId, remaining, this.server);
        if (remaining.length > 0) {
          await this.sendNodeActionGoal(robotId, remaining[0]);
        }
        return;
      }

      const isFinal = remaining.length === 1;
      const dist    = Math.hypot(x - node.x, y - node.y);

      // 적응형 통과 임계값 — 노드 간격이 NODE_PASS_M보다 좁은 맵(예: 401)에서, 직전
      // 노드에 머무는 동안 다음 노드가 이미 고정 임계 반경(1.5m) 안에 들어와 노드를
      // 통째로 건너뛰고 다다음 노드를 찾는 문제를 방지한다. 직전 노드(robot.location)
      // → 다음 노드 거리의 절반을 임계값으로 쓰되 NODE_PASS_M로 상한을 둔다.
      // (segLen/2 < segLen 이므로 직전 노드 위치에서는 절대 오발동하지 않는다)
      let threshold = isFinal ? NODE_ARRIVE_M : NODE_PASS_M;
      if (!isFinal) {
        const robot  = await this.robotService.findById(robotId);
        const fromId = robot?.location;
        if (fromId && fromId !== nextId) {
          const fromNode = await this.topologyService.findNodeById(fromId);
          if (fromNode) {
            const segLen = Math.hypot(fromNode.x - node.x, fromNode.y - node.y);
            threshold = Math.min(NODE_PASS_M, Math.max(0.15, segLen * 0.5));
          }
        }
      }

      this.logger.log(
        `[웨이포인트] ${robotId} pos=(${x.toFixed(2)},${y.toFixed(2)}) → next=${nextId}(${node.type})` +
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
          const diff     = normalizeAngle(outYaw - yaw);
          if (Math.abs(diff) > TaskManagerService.CORNER_THRESH) {
            this.logger.log(`[코너] ${robotId} @ ${nextId}: ${(Math.abs(diff) * 180 / Math.PI).toFixed(0)}° 회전 필요 — 2s 정지 후 회전 → ${nextNodeId}`);

            // Phase 1: 2초 정지
            this.hardStop(robotId);

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
        const actualRobot = await this.robotService.findById(robotId);
        const actualStatus = actualRobot?.status ?? 'IDLE';
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: actualStatus });
        // 신규 또는 복귀 로봇 전체 정보 브로드캐스트 (사이드바 즉시 반영)
        if (actualRobot) {
          this.server?.emit('robot_registered', actualRobot.toObject ? actualRobot.toObject() : { ...actualRobot });
        }

      } else if (!isNowOnline && wasOnline !== false) {
        this.robotOnlineState.set(robotId, false);

        // MOVING 상태에서 강제 종료 시에도 OFFLINE 처리 (기존 setOfflineIfIdle 대체)
        await this.robotService.setOffline(robotId);
        this.telemetryService.clearTelemetry(robotId);
        
        // 캐시 초기화 (배터리 및 위치 정보 날림)
        this.robotCache.set(robotId, { ...cache, batteryPct: null, posX: null, posY: null, yaw: null });

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

    // ── DB 기준 오프라인 보정 ────────────────────────────────────────────────
    // 위 캐시 루프는 "이번 세션에 메시지를 보낸" 로봇만 본다. 서버 재시작 후 꺼져
    // 있던 로봇이나, 끊긴 직후 stray 메시지로 IDLE로 되돌아간 로봇은 캐시에 살아있지
    // 않은데도 DB가 비-OFFLINE으로 남아 IDLE에 갇힌다. DB를 직접 훑어 확실히 정리.
    // (부팅 직후엔 온라인 로봇이 아직 첫 메시지를 못 보냈을 수 있어 유예시간 후 적용)
    if (now - this.startedAt > OFFLINE_AFTER_MS) {
      try {
        const notOffline = await this.robotService.findNotOffline();
        for (const r of notOffline) {
          const id = r.robot_id;
          const cache = this.robotCache.get(id);
          const live = !!cache && (now - cache.lastSeen < OFFLINE_AFTER_MS);
          if (live) continue;            // 실제 수신 중 → 캐시 루프가 관리
          if (this.activeTasks.has(id)) continue; // 진행 태스크는 위 루프가 처리

          await this.robotService.setOffline(id);
          this.telemetryService.clearTelemetry(id);
          this.robotOnlineState.set(id, false);
          this.server?.emit('robot_status_changed', { robot_id: id, status: 'OFFLINE' });
          this.logger.log(`[오프라인 보정] ${id} → OFFLINE (캐시 비활성 · DB ${r.status})`);
        }
      } catch (e) {
        this.logger.warn(`[오프라인 보정] 실패: ${String(e)}`);
      }
    }
  }

  // 완료/실패 태스크를 activeTasks에서 제거하고 로봇을 IDLE로 되돌린다.
  private async reconcileActiveTasks() {
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.activeTasks.delete(robotId); continue; }
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.activeTasks.delete(robotId);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      }
    }
  }

  // MOVING 상태이지만 활성 태스크가 없는(=goal 유실) 로봇을 IDLE로 강제 복구.
  private async recoverStuckMoving() {
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
  }

  // ── 디스패치 경로 해석 ────────────────────────────────────────────────────
  //
  // 실제 로직은 task-manager.dispatch.ts 의 resolveDispatchPath() 에 있다.
  // 여기서는 협력자(ctx)만 모아 전달한다.
  private dispatchCtx(): DispatchCtx {
    return {
      logger:          this.logger,
      fmsService:      this.fmsService,
      robotService:    this.robotService,
      topologyService: this.topologyService,
      robotCache:      this.robotCache,
      server:          this.server,
      emit:            (alert) => this.emit(alert),
    };
  }

  private async process() {
    if (!this.server) return;

    // 1. 완료/실패 태스크 → 로봇 해제
    await this.reconcileActiveTasks();
    // 1b. MOVING 상태이지만 활성 태스크 없는 로봇 → IDLE 복구
    await this.recoverStuckMoving();

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
      // 💡 LLM 이나 프론트에서 실수로 "null" 문자열을 보낼 수 있으므로 체크
      let robot: RobotDocument;
      const preferredId = (task.preferredRobotId === 'null') ? null : task.preferredRobotId;

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

      // ── 공급(SUPPLY) — omx 로봇팔 전용, 내비게이션 없이 즉시 보급 수행 ──────
      // targetNode는 목적지 노드가 아니라 보급 품목(물/약)이다. omx는 고정형이라
      // 경로 탐색·이동 단계를 건너뛰고 바로 완료 처리한다. (실제 로봇팔 액션 연동 지점)
      if (task.type === TaskType.SUPPLY) {
        await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
          assignedRobotId: robotId,
          startedAt:   new Date(),
          completedAt: new Date(),
        });
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
        this.emit({
          type: 'completed', taskId, robotId,
          message: `${robotId} 보급 완료 — ${task.targetNode}`,
          requiresAction: false,
        });
        this.logger.log(`[보급] ${robotId} → ${task.targetNode} 공급 완료 (task: ${taskId})`);
        continue;
      }

      this.logger.log(
        `[dispatch] ${robotId} 태스크 ${taskId} 배정 시작` +
        ` | location=${robot.location ?? 'null'}` +
        ` | AMCL pos=${cache?.posX != null ? `(${cache.posX.toFixed(2)},${(cache.posY ?? 0).toFixed(2)})` : 'N/A'}` +
        ` | target=${task.targetNode}`,
      );

      // ── 경로 탐색 (실패 시 null — waitReason/FAILED 처리는 내부에서 수행) ──
      const pathQueue = await resolveDispatchPath(this.dispatchCtx(), robot, task, taskId);
      if (pathQueue === null) continue;

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

  /** cmd_vel=0 정지를 3회 연속 발행 (nav2가 반응하기 전 확실한 정지 보장) */
  private hardStop(robotId: string) {
    for (let i = 0; i < 3; i++) this.fmsService.publishStop(robotId);
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
