import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TaskStatus, TaskType, TaskDocument } from '../task.schema';
import { RobotService } from '../../robot/robot.service';
import { RobotDocument, RobotStatus } from '../../robot/robot.schema';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from '../queue/global-task-queue.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { SupplyTaskHandler } from './task-handlers/supply-task.handler';
import { NavigationTaskHandler } from './task-handlers/navigation-task.handler';
import { ONLINE_MS } from '../../fms-shared/task-manager.constants';

/**
 * 배차(dispatch) — 글로벌 task queue를 매 tick 우선순위순으로 꺼내 로봇에 배정한다.
 *
 * 배정 정책:
 *  - preferredRobotId 가 있고 그 로봇이 가용  → 즉시 배정
 *  - preferredRobotId 가 있고 그 로봇이 작업 중(온라인) → 그 로봇의 per-robot queue에 적재
 *  - preferredRobotId 가 없음 → 가용 IDLE 로봇 중 하나에 배정
 *
 * 로봇이 활성 태스크를 끝내면 dispatchNext()가 per-robot queue에서 다음을 꺼내 실행한다.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly fmsService:   FmsService,
    private readonly robotService: RobotService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly globalQueue:  GlobalTaskQueueService,
    private readonly events:       TaskManagerEventsService,
    private readonly supplyHandler: SupplyTaskHandler,
    private readonly navHandler:    NavigationTaskHandler,
  ) {}

  // ── 메인 배차 루프 (매 tick) ───────────────────────────────────────────────

  async process(): Promise<void> {
    if (!this.events.hasServer) return;

    // 1. 완료/실패 활성 태스크 정리 (+ per-robot queue 소진)
    await this.reconcileActiveTasks();
    // 1b. MOVING이지만 활성 태스크 없는 로봇 복구
    await this.recoverStuckMoving();

    // 2. 글로벌 큐(PENDING) 탐색
    const pending = await this.globalQueue.getPending(20);
    if (!pending.length) return;

    // 3. 온라인 로봇 수집 — 가용(IDLE) / 작업 중(busy) 구분
    const now = Date.now();
    const freeRobots: RobotDocument[] = [];
    const onlineBusy = new Set<string>();
    for (const [robotId, cache] of this.robotState.entries()) {
      if (now - cache.lastSeen >= ONLINE_MS) continue;
      if (this.robotTasks.hasActive(robotId)) { onlineBusy.add(robotId); continue; }
      const robot = await this.robotService.autoRegister(robotId);
      if (robot.status === RobotStatus.IDLE) freeRobots.push(robot);
    }

    for (const task of pending) {
      const taskId = (task._id as { toString(): string }).toString();
      if (this.robotTasks.isClaimed(taskId)) continue; // 이미 어떤 로봇 큐에 커밋됨

      // 💡 LLM/프론트에서 "null" 문자열을 보낼 수 있으므로 체크
      const preferredId = (task.preferredRobotId === 'null') ? null : task.preferredRobotId;

      if (preferredId) {
        // 지정 로봇이 가용하면 즉시 배정
        const idx = freeRobots.findIndex((r) => r.robot_id === preferredId);
        if (idx !== -1) {
          const robot = freeRobots.splice(idx, 1)[0];
          await this.assign(robot, task, taskId);
          continue;
        }
        // 지정 로봇이 온라인이지만 작업 중 → per-robot queue에 적재
        if (onlineBusy.has(preferredId)) {
          const pos = this.robotTasks.enqueue(preferredId, taskId);
          await this.fmsService.setStatus(taskId, TaskStatus.ASSIGNED, this.events.server, {
            assignedRobotId: preferredId,
            waitReason:      `${preferredId} 작업 대기열 ${pos}번`,
          });
          this.events.emit(Alert.info(
            `${preferredId} 대기열 ${pos}번 적재 — [${task.type}] ${task.targetNode}`,
            { taskId, robotId: preferredId },
          ));
          continue;
        }
        // 지정 로봇 오프라인/미확인
        await this.fmsService.setWaitReason(taskId, `지정 로봇 ${preferredId} 대기 중`);
        continue;
      }

      // 지정 로봇 없음 → 가용 로봇 중 하나
      if (!freeRobots.length) continue; // 가용 로봇 없으면 글로벌 큐에 유지
      const robot = freeRobots.shift()!;
      await this.assign(robot, task, taskId);
    }
  }

  /**
   * 로봇이 활성 태스크를 끝냈을 때 호출 — 그 로봇의 per-robot queue에서 다음 태스크를
   * 꺼내 실행한다. 즉시완료(SUPPLY) 태스크는 건너뛰고 계속 다음을 시도한다.
   * @returns 주행 태스크를 실제로 착수했으면 true (홈 복귀 생략 신호로 사용)
   */
  async dispatchNext(robotId: string): Promise<boolean> {
    for (;;) {
      const nextId = this.robotTasks.popNext(robotId);
      if (!nextId) return false;

      const task = await this.fmsService.getTask(nextId);
      if (!task) continue;
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;

      const robot = await this.robotService.findById(robotId);
      if (!robot) return false;

      this.logger.log(`[로봇큐] ${robotId} 다음 태스크 착수: ${nextId} (${task.type})`);
      const started = await this.runHandler(robot, task, nextId);
      if (started) return true;
      // 즉시 완료(SUPPLY) → 큐의 다음 태스크 계속 시도
    }
  }

  // ── 내부 ───────────────────────────────────────────────────────────────────

  /** 가용 로봇에 태스크 실행 착수 (온라인 재확인 포함) */
  private async assign(robot: RobotDocument, task: TaskDocument, taskId: string): Promise<void> {
    const robotId = robot.robot_id;
    const cache  = this.robotState.getCache(robotId);
    const online = cache && (Date.now() - cache.lastSeen) < ONLINE_MS;
    if (!online) {
      this.logger.warn(`[dispatch] ${robotId} 오프라인 — 건너뜀`);
      await this.fmsService.setWaitReason(taskId, '로봇 오프라인 — 재연결 대기');
      return;
    }
    await this.runHandler(robot, task, taskId);
  }

  /** 태스크 타입별 핸들러 선택 후 실행 */
  private runHandler(robot: RobotDocument, task: TaskDocument, taskId: string): Promise<boolean> {
    if (task.type === TaskType.SUPPLY) {
      return this.supplyHandler.handle(robot, task, taskId);
    }
    return this.navHandler.handle(robot, task, taskId);
  }

  // 완료/실패 태스크를 활성 큐에서 제거하고 로봇을 IDLE로 되돌린 뒤 per-robot queue 소진
  private async reconcileActiveTasks(): Promise<void> {
    for (const [robotId, taskId] of [...this.robotTasks.activeEntries()]) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.robotTasks.clearActive(robotId); continue; }
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.robotTasks.clearActive(robotId);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
        await this.dispatchNext(robotId);
      }
    }
  }

  // MOVING 상태이지만 활성 태스크가 없는(=goal 유실) 로봇 복구
  private async recoverStuckMoving(): Promise<void> {
    for (const [robotId, cache] of [...this.robotState.entries()]) {
      if (this.robotTasks.hasActive(robotId)) continue;
      if ((Date.now() - cache.lastSeen) >= ONLINE_MS) continue;
      const robot = await this.robotService.findById(robotId);
      if (robot?.status !== RobotStatus.MOVING) continue;

      // 대기열에 다음 태스크가 있으면 그것을 착수, 없으면 IDLE 강제 복귀
      const started = await this.dispatchNext(robotId);
      if (started) continue;
      this.logger.warn(`[복구] ${robotId} — MOVING이지만 활성 태스크 없음 → IDLE 강제 복귀`);
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    }
  }
}
