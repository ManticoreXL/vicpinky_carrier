import { Injectable, Logger } from '@nestjs/common';
import { FmsService, CreateTaskDto } from '../fms.service';
import { TaskStatus, TaskDocument } from '../task.schema';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';

/**
 * 글로벌 task queue — 아직 어느 로봇에도 배정되지 않은 태스크의 대기열.
 *
 * 실제 영속 저장은 FmsService(Mongo)가 담당하고, 여기서는 "큐" 도메인 의미
 * (등록/배차투입/우선순위 조회/글로벌 반환)만 얇게 감싼다. DispatchService가
 * 매 tick 이 큐를 우선순위순으로 꺼내 로봇에 배정한다.
 */
@Injectable()
export class GlobalTaskQueueService {
  private readonly logger = new Logger(GlobalTaskQueueService.name);

  constructor(
    private readonly fmsService: FmsService,
    private readonly events:     TaskManagerEventsService,
  ) {}

  /** 우선순위 큐에 즉시 투입(PENDING) */
  async enqueue(dto: CreateTaskDto): Promise<TaskDocument> {
    const task = await this.fmsService.createQueued(dto);
    this.events.broadcast('fms_task_created', task);
    return task;
  }

  /** 등록만(DRAFT) — 자동 배차 대상 아님 */
  async register(dto: CreateTaskDto): Promise<TaskDocument> {
    const task = await this.fmsService.createDraft(dto);
    this.events.broadcast('fms_task_created', task);
    return task;
  }

  /** DRAFT → PENDING 배차 큐 투입 */
  async release(taskId: string): Promise<TaskDocument | null> {
    return this.fmsService.release(taskId, this.events.server);
  }

  /** 우선순위순 PENDING 태스크 */
  getPending(limit = 20): Promise<TaskDocument[]> {
    return this.fmsService.getPendingTasks(limit);
  }

  /** 진행 중(ASSIGNED/RUNNING) 태스크 (서버 재시작 복구용) */
  getInProgress(): Promise<TaskDocument[]> {
    return this.fmsService.getInProgressTasks();
  }

  /**
   * 특정 로봇에 커밋됐던 태스크를 다시 글로벌 큐(PENDING)로 되돌린다.
   * (로봇 오프라인 등으로 그 로봇이 더는 수행할 수 없을 때)
   */
  async requeue(taskId: string): Promise<void> {
    await this.fmsService.setStatus(taskId, TaskStatus.PENDING, this.events.server, {
      assignedRobotId: null,
      waitReason:      '로봇 오프라인 — 재배차 대기',
    });
    this.logger.log(`[글로벌큐] ${taskId} 재배차 큐로 반환`);
  }
}
