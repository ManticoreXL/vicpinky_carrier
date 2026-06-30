import { Injectable, Logger } from '@nestjs/common';
import { TaskType } from './task.schema';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { TaskPlannerService } from './task-planner.service';
import { GlobalTaskQueueService } from './global-task-queue.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';

/**
 * 자동 디스패처 (on/off) — TaskManagerService에서 분리한 자동 할당 로직.
 *
 * ON이면: 로봇 미지정 단건 태스크를 "태스크 우선순위순"으로, "우선순위 로봇 로직의 최우선 가용 로봇"에
 * 자동 할당한다. 가용 로봇이 없으면 보류(다음 주기 재시도) — 로봇이 생길 때까지 큐에서 대기.
 * TaskManagerService의 상태 틱이 매 주기 runIfEnabled()를 호출한다.
 */
@Injectable()
export class AutoDispatcherService {
  private readonly logger = new Logger(AutoDispatcherService.name);
  private autoDispatch = false;

  constructor(
    private readonly taskRepo:    TaskRepositoryService,
    private readonly taskStatus:  TaskStatusService,
    private readonly robotTasks:  RobotTaskQueueService,
    private readonly planner:     TaskPlannerService,
    private readonly globalQueue: GlobalTaskQueueService,
    private readonly events:      TaskManagerEventsService,
  ) {}

  setAutoDispatch(on: boolean): void {
    this.autoDispatch = on;
    this.logger.log(`[자동디스패처] ${on ? 'ON — 미배정 태스크 자동 할당 시작' : 'OFF'}`);
  }
  isAutoDispatch(): boolean { return this.autoDispatch; }

  /** 상태 틱에서 매 주기 호출 — ON일 때만 1회 자동 디스패치 실행. */
  async runIfEnabled(): Promise<void> {
    if (this.autoDispatch) await this.runAutoDispatch();
  }

  private async runAutoDispatch(): Promise<void> {
    if (!this.events.hasServer) return;
    const tasks = await this.taskRepo.findAutoDispatchable(); // 단건 DRAFT/PENDING, 태스크 우선순위순
    for (const t of tasks) {
      const taskId = String(t._id);
      const preferred = t.preferredRobotId && t.preferredRobotId !== 'null' ? t.preferredRobotId : null;

      // 선점 유형(복귀·일시정지)은 지정 로봇으로 즉시 실행 — 재배정 안 함(로봇 전용 동작).
      if (t.type === TaskType.RECALL || t.type === TaskType.PAUSE) {
        if (preferred) await this.planner.planTask(taskId);
        continue;
      }

      // 그 외: 로봇 우선순위 랭킹으로 "무조건" 자동 배정.
      //  - 지정 로봇이 가용(온라인·비busy)하면 그 로봇, 아니면 랭킹 최우선 가용 로봇으로 재배정(지정이 작업 중이어도 대기하지 않음).
      const isSupply = t.type === TaskType.SUPPLY;
      const ranked = await this.globalQueue.rankRobotsForTarget(t.targetNode, t.type);
      const avail = ranked.filter((r) =>
        r.online && !r.busy && (isSupply ? r.robotId.startsWith('omx') : !r.robotId.startsWith('omx')));
      const robot = (preferred && avail.some((r) => r.robotId === preferred)) ? preferred : (avail[0]?.robotId ?? null);
      if (!robot) continue; // 가용 로봇 없음 → 다음 주기 재시도

      await this.taskStatus.prepareForDispatch(taskId, robot); // 로봇 지정 + DRAFT→PENDING
      await this.planner.planTask(taskId);
      this.logger.log(`[자동디스패처] ${taskId} (${t.type}→${t.targetNode || '-'}) → ${robot} 자동 배정${preferred && robot !== preferred ? ` (지정 ${preferred} 미가용 → 재배정)` : ''}`);
    }
  }
}
