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
const ONLINE_MS        = 5_000;   // 태스크 할당 시 "온라인 판정" 기준 (ms)
const OFFLINE_AFTER_MS = 10_000;  // 마지막 메시지 후 이 시간 초과 시 OFFLINE 처리 (ms)
const BATTERY_MIN_PCT  = 20;
const GOAL_ARRIVE_M    = 0.35;

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
  private readonly activeTasks    = new Map<string, string>();
  // robotId → 홈 위치
  private readonly homePositions  = new Map<string, { x: number; y: number; yaw: number }>();
  // robotId → ROS 상태 캐시
  private readonly robotCache     = new Map<string, RobotCache>();
  // 배터리 알림 중복 방지
  private readonly lastBatteryAlert = new Map<string, number>();
  // robotId → 직전 동기화 시점의 온라인 여부 (undefined = 미확인)
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
    this.logger.log('TaskManager 시작');
  }

  onModuleDestroy() {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  setServer(server: Server) { this.server = server; }

  // ── 외부 API ─────────────────────────────────────────────────────────────

  async enqueue(dto: Parameters<FmsService['createQueued']>[0]) {
    const task = await this.fmsService.createQueued(dto);
    this.server?.emit('fms_task_created', task);
    return task;
  }

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.homePositions.set(robotId, { x, y, yaw });
    this.logger.log(`홈 설정: ${robotId} (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── ROS 메시지 처리 ─────────────────────────────────────────────────────

  private handleRosMessage(msg: RosMessage) {
    const now = Date.now();

    // 마지막 수신 시각 갱신
    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch) {
      const id   = botMatch[1];
      const prev = this.robotCache.get(id) ?? { lastSeen: 0, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    // 배터리
    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id  = batMatch[1];
      let pct   = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    // amcl_pose — 도착 감지
    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id  = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos = poseData?.position;
      const ori = poseData?.orientation;
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

  private async interpolatePath(path: string[]): Promise<string[]> {
    const result: string[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const startId = path[i];
      const endId = path[i + 1];
      const start = await this.topologyService.findNodeById(startId);
      const end = await this.topologyService.findNodeById(endId);
      if (!start || !end) {
        result.push(endId);
        continue;
      }
      
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dist = Math.hypot(dx, dy);
      const numPoints = Math.floor(dist / 0.5); // 0.5m 간격 웨이포인트
      
      // 실제 시작 노드는 이미 포함되어 있거나 처리됨. 여기서는 중간 웨이포인트만.
      for (let j = 1; j <= numPoints; j++) {
        const rx = start.x + (dx * j) / (numPoints + 1);
        const ry = start.y + (dy * j) / (numPoints + 1);
        const yaw = Math.atan2(dy, dx);
        result.push(`coord:${rx.toFixed(3)}:${ry.toFixed(3)}:${yaw.toFixed(3)}`);
      }
      result.push(endId);
    }
    return result.length > 0 ? result : path;
  }

  // ── Waypoint 도착 감지 ────────────────────────────────────────────────────

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

    const nextNodeId = remaining[0];
    let targetX: number, targetY: number, targetYaw: number;
    let isVirtual = false;

    if (nextNodeId.startsWith('coord:')) {
      const parts = nextNodeId.split(':');
      targetX = parseFloat(parts[1]);
      targetY = parseFloat(parts[2]);
      targetYaw = parseFloat(parts[3]);
      isVirtual = true;
    } else {
      const node = await this.topologyService.findNodeById(nextNodeId);
      if (!node) return;
      targetX = node.x; targetY = node.y; targetYaw = node.yaw;
    }

    const dist = Math.hypot(x - targetX, y - targetY);
    if (dist > GOAL_ARRIVE_M) return;

    // 현재 waypoint 도착 → 위치 갱신 (실제 노드일 때만)
    if (!isVirtual) {
      await this.robotService.updateLocation(robotId, nextNodeId);
    }
    remaining.shift();

    if (remaining.length > 0) {
      // 다음 waypoint로 이동
      await this.fmsService.updatePathQueue(taskId, remaining, this.server);
      const nextId = remaining[0];
      let nx: number, ny: number, nyaw: number;
      if (nextId.startsWith('coord:')) {
        const parts = nextId.split(':');
        nx = parseFloat(parts[1]); ny = parseFloat(parts[2]); nyaw = parseFloat(parts[3]);
      } else {
        const nextNode = await this.topologyService.findNodeById(nextId);
        if (!nextNode) return;
        nx = nextNode.x; ny = nextNode.y; nyaw = nextNode.yaw;
      }
      this.fmsService.publishGoal(robotId, nx, ny, nyaw);
      this.emit({ type: 'info', taskId, robotId, message: `${robotId} → ${nextId} 이동 중`, requiresAction: false });
    } else {
      // 최종 목적지 도착 → 태스크 완료
      this.activeTasks.delete(robotId);
      // dot notation 대신 전체 객체로 교체 (프론트 shallow merge 대응)
      await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
        completedAt: new Date(),
        assignedRobot: { robot_id: robotId, is_completed: true },
      });
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.emit({ type: 'completed', taskId, robotId, message: `${robotId} 태스크 완료 (${task.targetNode})`, requiresAction: false });
      
      // 이동 종료 후 현재 위치를 InitialPose로 강제 전송
      this.fmsService.publishInitialPose(robotId, x, y, yaw);
      
      this.returnHome(robotId);
    }
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

  // ── 온라인/오프라인 자동 전환 ─────────────────────────────────────────────

  private async syncOnlineStatus() {
    const now = Date.now();

    for (const [robotId, cache] of this.robotCache.entries()) {
      const isNowOnline = now - cache.lastSeen < OFFLINE_AFTER_MS;
      const wasOnline   = this.robotOnlineState.get(robotId);

      if (isNowOnline && wasOnline !== true) {
        // 오프라인이었거나 최초 감지 → IDLE 복귀/등록
        this.robotOnlineState.set(robotId, true);
        await this.robotService.bringOnlineIfOffline(robotId);
        if (wasOnline === false) {
          // 명시적으로 오프라인 → 온라인 복귀
          this.logger.log(`[온라인] ${robotId} 복귀`);
          this.emit({ type: 'info', robotId, message: `${robotId} 온라인 복귀`, requiresAction: false });
          this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
        } else {
          this.logger.log(`[온라인] ${robotId} 최초 감지`);
          this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
        }
      } else if (!isNowOnline && wasOnline !== false) {
        // 온라인이었거나 최초 타임아웃 → OFFLINE 처리
        this.robotOnlineState.set(robotId, false);
        await this.robotService.setOfflineIfIdle(robotId);
        this.logger.warn(`[오프라인] ${robotId} — 마지막 수신 ${((now - cache.lastSeen) / 1000).toFixed(1)}s 전`);
        this.emit({ type: 'robot_offline', robotId, message: `${robotId} 오프라인 (토픽 미수신)`, requiresAction: true });
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'OFFLINE' });
      }
    }
  }

  private async process() {
    if (!this.server) return;

    // 1. 완료/실패된 태스크 → 로봇 해제
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.activeTasks.delete(robotId); continue; }
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.activeTasks.delete(robotId);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      }
    }

    // 2. PENDING 태스크에서 실행 가능한 것 탐색
    const pending = await this.fmsService.getPendingTasks(20);
    if (!pending.length) return;

    // 3. 사용 가능한 IDLE 로봇 목록 (ROS 캐시 기반 + DB 자동 등록)
    const now2 = Date.now();
    const freeRobots: RobotDocument[] = [];
    for (const [robotId, cache] of this.robotCache.entries()) {
      if (now2 - cache.lastSeen >= ONLINE_MS) continue;   // ROS 미응답 → 오프라인
      if (this.activeTasks.has(robotId)) continue;         // 이미 작업 할당
      const robot = await this.robotService.autoRegister(robotId);
      if (robot.status === RobotStatus.IDLE) freeRobots.push(robot);
    }
    if (!freeRobots.length) return;

    for (const task of pending) {
      if (!freeRobots.length) break;

      // 태스크 타입에 맞는 로봇 선택 (CHARGE → CHARGER 노드 보유 로봇 우선 등은 추후 확장)
      const robot = freeRobots.shift()!;
      const robotId = robot.robot_id;
      const taskId  = (task._id as { toString(): string }).toString();

      // ── CheckRobot ────────────────────────────────────────────────────────
      const cache  = this.robotCache.get(robotId);
      const online = cache && (Date.now() - cache.lastSeen) < ONLINE_MS;
      if (!online) {
        await this.fmsService.setWaitReason(taskId, '로봇 오프라인 — 재연결 대기');
        freeRobots.unshift(robot); // 반환
        continue;
      }

      // ── BatteryCheck ──────────────────────────────────────────────────────
      const bat = cache?.batteryPct;
      if (bat != null && bat < BATTERY_MIN_PCT) {
        await this.fmsService.setWaitReason(taskId, `배터리 부족 (${bat.toFixed(0)}%)`);
        const lastAlert = this.lastBatteryAlert.get(robotId) ?? 0;
        if (Date.now() - lastAlert > 60_000) {
          this.lastBatteryAlert.set(robotId, Date.now());
          this.emit({ type: 'battery', taskId, robotId,
            message: `${robotId} 배터리 부족 (${bat.toFixed(0)}%)`,
            requiresAction: true });
        }
        freeRobots.unshift(robot);
        continue;
      }

      // ── 경로 탐색 ─────────────────────────────────────────────────────────
      let pathQueue: string[] = [];
      if (robot.location && robot.location !== task.targetNode) {
        // targetNode가 어느 맵인지 찾기
        const targetNode = await this.topologyService.findNodeById(task.targetNode);
        if (targetNode) {
          let rawPath = await this.topologyService.findPath(
            robot.location, task.targetNode, targetNode.map_id,
          );
          if (rawPath.length > 0) {
            pathQueue = await this.interpolatePath(rawPath);
            // 시작 노드는 이미 있으므로 제외 (실제 노드이든 가상 노드이든 시작점은 제외할 필요가 있음)
            if (pathQueue.length > 0 && pathQueue[0] === robot.location) {
              pathQueue.shift();
            }
          }
        }
        if (pathQueue.length === 0) {
          await this.fmsService.setWaitReason(taskId, `경로 없음: ${robot.location} → ${task.targetNode}`);
          this.emit({ type: 'task_failed', taskId, robotId,
            message: `경로를 찾을 수 없음: ${robot.location} → ${task.targetNode}`,
            requiresAction: false });
          await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
          continue;
        }
      } else {
        // 현재 위치 모름 or 이미 목적지 — 바로 목적지로
        pathQueue = [task.targetNode];
      }

      // ── AssignTask ────────────────────────────────────────────────────────
      this.activeTasks.set(robotId, taskId);
      await this.fmsService.assignToRobot(taskId, robotId, pathQueue, this.server!);
      await this.robotService.updateStatus(robotId, RobotStatus.MOVING);

      // 첫 번째 waypoint로 이동 시작
      const firstId = pathQueue[0];
      let firstX: number, firstY: number, firstYaw: number;
      if (firstId.startsWith('coord:')) {
        const parts = firstId.split(':');
        firstX = parseFloat(parts[1]); firstY = parseFloat(parts[2]); firstYaw = parseFloat(parts[3]);
      } else {
        const firstNode = await this.topologyService.findNodeById(firstId);
        if (firstNode) {
          firstX = firstNode.x; firstY = firstNode.y; firstYaw = firstNode.yaw;
        } else {
          firstX = 0; firstY = 0; firstYaw = 0;
        }
      }
      this.fmsService.publishGoal(robotId, firstX, firstY, firstYaw);

      this.emit({
        type: 'assigned', taskId, robotId,
        message: `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당`,
        requiresAction: false,
      });
    }
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
