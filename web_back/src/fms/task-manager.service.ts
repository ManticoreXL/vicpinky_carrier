import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService } from './fms.service';
import { RosService } from '../ros/ros.service';
import type { RosMessage } from '../ros/ros.types';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const LOOP_MS         = 2_000;  // 처리 루프 주기
const ONLINE_MS       = 5_000;  // 이 시간 내 메시지가 없으면 오프라인
const BATTERY_MIN_PCT = 20;     // 이 이하면 배터리 부족
const GOAL_ARRIVE_M   = 0.35;   // 목표 도착 판정 거리 (m)

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
  lastSeen: number;
  batteryPct: number | null;
  posX: number | null;
  posY: number | null;
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private server: Server | null = null;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;

  // robotId → 현재 활성 taskId (TaskManager가 할당한 것)
  private readonly activeTasks = new Map<string, string>();
  // robotId → 목표 좌표 (navigate 태스크)
  private readonly pendingGoals = new Map<string, { x: number; y: number; taskId: string }>();
  // robotId → 홈 위치
  private readonly homePositions = new Map<string, { x: number; y: number; yaw: number }>();
  // robotId → 마지막 ROS 상태
  private readonly robotCache = new Map<string, RobotCache>();
  // 최근 배터리 알림 시간 (중복 방지)
  private readonly lastBatteryAlert = new Map<string, number>();

  constructor(
    private readonly fmsService: FmsService,
    private readonly rosService: RosService,
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

  /** Gateway가 초기화 후 서버 참조를 주입 */
  setServer(server: Server) {
    this.server = server;
  }

  // ── 외부 API ─────────────────────────────────────────────────────────────

  async enqueue(dto: Parameters<FmsService['createQueued']>[0]) {
    const task = await this.fmsService.createQueued(dto);
    if (this.server) this.server.emit('fms_task_created', task);
    return task;
  }

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.homePositions.set(robotId, { x, y, yaw });
    this.logger.log(`홈 위치 설정: ${robotId} (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 — 서버는 별도 처리 없음 */ }

  // ── ROS 메시지 처리 ─────────────────────────────────────────────────────

  private handleRosMessage(msg: RosMessage) {
    const now = Date.now();

    // 온라인 타임스탬프 갱신
    const robotMatch = msg.topic.match(/^\/([^/]+)\//);
    if (robotMatch) {
      const id = robotMatch[1];
      const prev = this.robotCache.get(id) ?? { lastSeen: 0, batteryPct: null, posX: null, posY: null };
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    // 배터리
    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id = batMatch[1];
      let pct = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct = pct * 100; // 0-1 → 0-100
      const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null };
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    // amcl_pose — navigate 태스크 도착 감지
    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id = amclMatch[1];
      const pos = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number } } } })
        ?.pose?.pose?.position;
      if (pos?.x != null) {
        const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null };
        this.robotCache.set(id, { ...prev, posX: pos.x, posY: pos.y ?? 0 });
        void this.checkGoalArrival(id, pos.x, pos.y ?? 0);
      }
    }
  }

  private async checkGoalArrival(robotId: string, x: number, y: number) {
    const goal = this.pendingGoals.get(robotId);
    if (!goal) return;
    const dist = Math.hypot(x - goal.x, y - goal.y);
    if (dist > GOAL_ARRIVE_M) return;

    this.pendingGoals.delete(robotId);
    this.activeTasks.delete(robotId);

    if (this.server) {
      await this.fmsService.setStatus(goal.taskId, 'completed', this.server, { completedAt: new Date() });
    }
    this.emit({ type: 'completed', taskId: goal.taskId, robotId, message: `${robotId} 목표 도착 완료`, requiresAction: false });
    this.returnHome(robotId);
  }

  // ── 메인 처리 루프 ───────────────────────────────────────────────────────

  private async tick() {
    if (!this.running) return;
    try { await this.process(); } catch (e) { this.logger.error('루프 오류', e); }
    this.loopTimer = setTimeout(() => void this.tick(), LOOP_MS);
  }

  private async process() {
    if (!this.server) return;

    // ── 1. 완료된 태스크 → 로봇 해제 ──────────────────────────────────────
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.activeTasks.delete(robotId); continue; }
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.activeTasks.delete(robotId);
        this.pendingGoals.delete(robotId);
        if (task.status === 'completed') this.returnHome(robotId);
      }
    }

    // ── 2. 큐에서 실행 가능한 태스크 탐색 ────────────────────────────────
    const queued = await this.fmsService.getQueuedTasks(20);
    if (!queued.length) return;

    for (const task of queued) {
      const robotId = task.robotId;

      // 이미 이 로봇에 활성 태스크 있음
      if (this.activeTasks.has(robotId)) continue;

      const taskId = task._id.toString();

      // ── DetermineTopTask ──────────────────────────────────────────────
      if (!this.canPerform(task.type, robotId)) {
        await this.fmsService.setStatus(taskId, 'failed', this.server, { completedAt: new Date() });
        this.emit({ type: 'task_failed', taskId, robotId, message: `[${task.type}] ${robotId}에 수행 불가`, requiresAction: false });
        continue;
      }

      // ── CheckRobot ────────────────────────────────────────────────────
      const cache = this.robotCache.get(robotId);
      const online = cache && (Date.now() - cache.lastSeen) < ONLINE_MS;
      if (!online) {
        await this.fmsService.setWaitReason(taskId, '로봇 오프라인 — 재연결 대기');
        continue;
      }

      // ── BatteryCheck ──────────────────────────────────────────────────
      const bat = cache?.batteryPct;
      if (bat != null && bat < BATTERY_MIN_PCT) {
        await this.fmsService.setWaitReason(taskId, `배터리 부족 (${bat.toFixed(0)}%) — 충전 필요`);
        const lastAlert = this.lastBatteryAlert.get(robotId) ?? 0;
        if (Date.now() - lastAlert > 60_000) { // 1분에 한 번만 알림
          this.lastBatteryAlert.set(robotId, Date.now());
          this.emit({
            type: 'battery', taskId, robotId,
            message: `${robotId} 배터리 부족 (${bat.toFixed(0)}%) — 충전 후 자동 재시도`,
            requiresAction: true,
          });
        }
        continue;
      }

      // ── CheckRobotStatus (온라인 = 정상 가정, 추후 진단 확장 가능) ────

      // ── AssignTask ────────────────────────────────────────────────────
      this.activeTasks.set(robotId, taskId);
      await this.fmsService.activateAndDispatch(taskId, this.server);

      // navigate 태스크 → 목표 좌표 등록 (도착 감지용)
      if (task.type === 'navigate' && task.goalX != null && task.goalY != null) {
        this.pendingGoals.set(robotId, { x: task.goalX, y: task.goalY, taskId });
      }

      this.emit({
        type: 'assigned', taskId, robotId,
        message: `${robotId} → [${task.type}] P${task.priority} 태스크 할당`,
        requiresAction: false,
      });
    }
  }

  // ── 헬퍼 ─────────────────────────────────────────────────────────────────

  private canPerform(type: string, robotId: string): boolean {
    if (type === 'carrier_task' && robotId !== 'vicpinky') return false;
    if (type === 'navigate'     && !robotId.startsWith('tb3_')) return false;
    return true;
  }

  private returnHome(robotId: string) {
    const home = this.homePositions.get(robotId);
    if (!home) return;
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName: `/${robotId}/goal_pose`,
      messageType: 'geometry_msgs/PoseStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          position: { x: home.x, y: home.y, z: 0 },
          orientation: { x: 0, y: 0, z: Math.sin(home.yaw / 2), w: Math.cos(home.yaw / 2) },
        },
      },
    });
    this.emit({ type: 'info', robotId, message: `${robotId} 홈 포지션 복귀 중`, requiresAction: false });
  }

  private emit(alert: Omit<TaskManagerAlert, 'id' | 'timestamp'>) {
    if (!this.server) return;
    const full: TaskManagerAlert = {
      ...alert,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.server.emit('task_manager_alert', full);
    this.logger.log(`[TM] ${full.message}`);
  }
}
