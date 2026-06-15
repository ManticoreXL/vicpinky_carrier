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
const OFFLINE_AFTER_MS = 30_000;
const BATTERY_MIN_PCT  = 20;

// 위치 감지 반경 (노드 위주 경로)
const NODE_PASS_M   = 1.5;  // 중간 노드 통과 감지
const NODE_ARRIVE_M = 0.5;  // 최종 목적지 도착 감지 (action result 백업)

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface TaskManagerAlert {
  id: string;
  type: 'battery' | 'robot_offline' | 'task_failed' | 'assigned' | 'completed' | 'info';
  taskId?: string;
  robotId?: string;
  message: string;
  requiresAction: boolean;
  timestamp: number;
}

interface RobotCache {
  lastSeen:   number;
  batteryPct: number | null;
  posX:       number | null;
  posY:       number | null;
  yaw:        number | null;
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
  // 배터리 알림 중복 방지
  private readonly lastBatteryAlert = new Map<string, number>();
  // robotId → 온라인 여부 (undefined = 미확인)
  private readonly robotOnlineState = new Map<string, boolean>();

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
        const robotId = task.assignedRobot?.robot_id;
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

    const robotId = task.assignedRobot?.robot_id;

    if (robotId) {
      // cmd_vel=0 정지 (goal_pose 토픽 방식이므로 action cancel 불필요)
      for (let i = 0; i < 3; i++) {
        this.fmsService.publishStop(robotId);
      }

      this.activeTasks.delete(robotId);

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
      await this.sendNodeActionGoal(robotId, newQueue[0], taskId);
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
      const prev = this.robotCache.get(id) ?? { lastSeen: 0, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id  = batMatch[1];
      let pct   = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id       = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos      = poseData?.position;
      const ori      = poseData?.orientation;
      if (pos?.x != null) {
        const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null };
        let yaw = 0;
        if (ori) {
          yaw = Math.atan2(2 * ((ori.w ?? 1) * (ori.z ?? 0) + (ori.x ?? 0) * (ori.y ?? 0)), 1 - 2 * ((ori.y ?? 0) ** 2 + (ori.z ?? 0) ** 2));
        }
        this.robotCache.set(id, { ...prev, posX: pos.x, posY: pos.y ?? 0, yaw });
        void this.checkWaypointArrival(id, pos.x, pos.y ?? 0, yaw);
      }
    }
  }

  // ── 중간 웨이포인트 보간 ─────────────────────────────────────────────────
  // 노드 간 0.5m 간격의 좌표 웨이포인트를 삽입해 엣지를 정확히 따라가게 함

  // ── 경유 노드 통과 감지 (위치 추적 전용) ────────────────────────────────

  private async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number) {
    const taskId = this.activeTasks.get(robotId);
    if (!taskId || !this.server) return;

    const task = await this.fmsService.getTask(taskId);
    if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
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

    if (Math.hypot(x - node.x, y - node.y) > threshold) return;

    // 노드 통과/도착: 위치·점유 갱신
    await this.robotService.updateLocation(robotId, nextId);

    if (isFinal) {
      this.activeTasks.delete(robotId);

      await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
        completedAt: new Date(),
        assignedRobot: { robot_id: robotId, is_completed: true },
      });
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.emit({ type: 'completed', taskId, robotId, message: `${robotId} 태스크 완료 (${task.targetNode})`, requiresAction: false });
      this.fmsService.publishInitialPose(robotId, x, y, yaw);
      this.returnHome(robotId);
      return;
    }

    remaining.shift();
    await this.fmsService.updatePathQueue(taskId, remaining, this.server);
  }

  // ── 메인 처리 루프 ───────────────────────────────────────────────────────

  private async tick() {
    if (!this.running) return;
    try {
      await this.syncOnlineStatus();
      await this.process();
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
        if (wasOnline === false) {
          this.emit({ type: 'info', robotId, message: `${robotId} 온라인 복귀`, requiresAction: false });
        }
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: actualStatus });

      } else if (!isNowOnline && wasOnline !== false) {
        this.robotOnlineState.set(robotId, false);

        // MOVING 상태에서 강제 종료 시에도 OFFLINE 처리 (기존 setOfflineIfIdle 대체)
        await this.robotService.setOffline(robotId);

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

      // 배터리 확인
      const bat = cache?.batteryPct;
      if (bat != null && bat < BATTERY_MIN_PCT) {
        await this.fmsService.setWaitReason(taskId, `배터리 부족 (${bat.toFixed(0)}%)`);
        const lastAlert = this.lastBatteryAlert.get(robotId) ?? 0;
        if (Date.now() - lastAlert > 60_000) {
          this.lastBatteryAlert.set(robotId, Date.now());
          this.emit({ type: 'battery', taskId, robotId, message: `${robotId} 배터리 부족 (${bat.toFixed(0)}%)`, requiresAction: true });
        }
        freeRobots.unshift(robot);
        continue;
      }

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
        pathQueue = [task.targetNode];
      } else {
        const rawPath = await this.topologyService.findPath(startNodeId, task.targetNode, myMapId);
        if (rawPath.length === 0) {
          await this.fmsService.setWaitReason(taskId, `경로 없음: ${startNodeId} → ${task.targetNode}`);
          this.emit({ type: 'task_failed', taskId, robotId, message: `경로를 찾을 수 없음: ${startNodeId} → ${task.targetNode}`, requiresAction: false });
          await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
          continue;
        }
        pathQueue = rawPath.slice(1);
      }

      this.activeTasks.set(robotId, taskId);

      await this.fmsService.assignToRobot(taskId, robotId, pathQueue, this.server!);
      await this.robotService.updateStatus(robotId, RobotStatus.MOVING);

      const firstGoalId = pathQueue[0] ?? task.targetNode;
      await this.sendNodeActionGoal(robotId, firstGoalId, taskId);

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

  private async sendNodeActionGoal(robotId: string, nodeId: string, taskId: string): Promise<void> {
    const node = await this.topologyService.findNodeById(nodeId);
    if (!node) {
      this.logger.warn(`[sendNodeGoal] 노드 "${nodeId}" DB에 없음`);
      return;
    }
    this.fmsService.publishGoal(robotId, node.x, node.y, node.yaw);
    this.logger.log(`[goal_pose] ${robotId} → ${nodeId} (${node.x.toFixed(2)}, ${node.y.toFixed(2)})`);
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
