import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession } from 'mongoose';
import { Server } from 'socket.io';
import { TaskHistory, TaskHistoryDocument, TaskStatus, TaskType } from './task.schema';
import { CreateTaskDto } from './task.dto';
import { sortByPriority } from './task-priority';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';

// task_id 자동 생성 헬퍼
function genTaskId(): string {
  return `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * 태스크 데이터 계층 — 생성/조회/삭제/목록(DB CRUD)만 담당.
 * 상태 전이(ASSIGNED/RUNNING/...)는 TaskStatusService가 담당한다.
 */
@Injectable()
export class TaskRepositoryService {
  private readonly logger = new Logger(TaskRepositoryService.name);

  constructor(
    @InjectModel(TaskHistory.name) private readonly taskModel: Model<TaskHistoryDocument>,
    private readonly events: TaskManagerEventsService,
  ) {}

  // ── 우선순위 큐에 등록 (PENDING) ──────────────────────────────────────────
  async createQueued(dto: CreateTaskDto, session?: ClientSession): Promise<TaskHistoryDocument> {
    const payload = {
      task_id:          dto.task_id ?? genTaskId(),
      label:            dto.label ?? '',
      type:             dto.type,
      targetNode:       dto.targetNode ?? '',
      priority:         dto.priority ?? 5,
      seq:              dto.seq ?? 0,
      batchId:          dto.batchId ?? null,
      scenarioId:       dto.scenarioId ?? null,
      repeat:           dto.repeat ?? false,
      status:           TaskStatus.PENDING,
      preferredRobotId: dto.preferredRobotId ?? null,
      assignedRobotId:  dto.assignedRobotId ?? null,
      rosPlan:          dto.rosPlan ?? [],   // 커스텀 혼합 스텝(있으면 dispatch가 그대로 실행)
    };
    // 세션이 있으면 트랜잭션에 참여(배열 형태 필수), 없으면 단건 생성
    const task = session
      ? (await this.taskModel.create([payload], { session }))[0]
      : await this.taskModel.create(payload);
    const robotLabel = dto.preferredRobotId ? ` → ${dto.preferredRobotId}` : '';
    this.logger.log(`태스크 등록: ${task.task_id} [${dto.type}→${dto.targetNode}] P${dto.priority ?? 5}${robotLabel}`);
    return task;
  }

  // ── 실패 작업 글로벌 큐 반납 — 원본과 같은 내용의 새 PENDING(미배정) 재등록 + 생성 브로드캐스트 ──
  /**
   * 실행 실패(task-execution.failTask)·로봇 이탈(robot-monitor.releaseRobotTasks)이 공유하는 반납 헬퍼.
   * 원본은 호출부에서 FAILED 로 이력 보존하고, 여기서 같은 내용의 새 PENDING(미배정)을 만들어 글로벌 큐로 되돌린다.
   * 커스텀 태스크는 rosPlan·label 도 복사해야 새 로봇 할당 시 스텝대로 실행된다(미복사 시 "목적지 없는 MOVE"로 즉시 실패).
   */
  async requeueFailedCopy(task: Pick<TaskHistory, 'label' | 'type' | 'targetNode' | 'priority' | 'rosPlan'>): Promise<TaskHistoryDocument> {
    const fresh = await this.createQueued({
      label:      task.label,
      type:       task.type,
      targetNode: task.targetNode || undefined,
      priority:   task.priority,
      rosPlan:    task.rosPlan && task.rosPlan.length ? task.rosPlan : undefined,
    });
    this.events.broadcast('fms_task_created', fresh);
    return fresh;
  }

  // ── 등록만(할당 X) — DRAFT 상태로 생성 ───────────────────────────────────
  async createDraft(dto: CreateTaskDto): Promise<TaskHistoryDocument> {
    const task = await this.taskModel.create({
      task_id:          dto.task_id ?? genTaskId(),
      type:             dto.type,
      targetNode:       dto.targetNode ?? '',
      priority:         dto.priority ?? 5,
      status:           TaskStatus.DRAFT,
      preferredRobotId: dto.preferredRobotId ?? null,
    });
    const robotLabel = dto.preferredRobotId ? ` → ${dto.preferredRobotId}` : '';
    this.logger.log(`태스크 등록(미할당): ${task.task_id} [${dto.type}→${dto.targetNode}] P${dto.priority ?? 5}${robotLabel}`);
    return task;
  }

  // ── 단건 조회 ─────────────────────────────────────────────────────────────
  async getTask(taskId: string): Promise<TaskHistoryDocument | null> {
    return this.taskModel.findById(taskId).exec();
  }

  // ── 복귀(반납) — 한 로봇이 보유한 미완료 태스크(복귀 자신 제외) ────────────
  /** 해당 로봇에 묶인 PENDING/ASSIGNED/RUNNING 태스크(복귀 제외) — 글로벌 큐 반납 대상. */
  async findReturnableByRobot(robotId: string): Promise<TaskHistoryDocument[]> {
    return this.taskModel.find({
      status: { $in: [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.RUNNING] },
      type:   { $ne: TaskType.RECALL },
      $or:    [{ assignedRobotId: robotId }, { preferredRobotId: robotId }],
    }).exec();
  }

  // ── 목적지 노드 갱신 (복귀 등 dispatch 시점 해석) ────────────────────────────
  async setTargetNode(taskId: string, node: string): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { $set: { targetNode: node } });
  }

  // ── 자동 디스패처 대상 — 단건(연속/시나리오 아님) DRAFT/PENDING, 우선순위순 ──
  // 지정 로봇 있으면 그 로봇으로 자동 실행, 없으면 최우선 가용 로봇 자동 배정(호출부에서 분기).
  async findAutoDispatchable(): Promise<Array<{ _id: unknown; type: TaskType; targetNode: string; status: TaskStatus; preferredRobotId: string | null }>> {
    const docs = await this.taskModel.find({
      status:     { $in: [TaskStatus.DRAFT, TaskStatus.PENDING] },
      batchId:    null,
      scenarioId: null,
    }).lean().exec();
    sortByPriority(docs as Array<{ status?: TaskStatus; type?: TaskType }>);
    return docs as unknown as Array<{ _id: unknown; type: TaskType; targetNode: string; status: TaskStatus; preferredRobotId: string | null }>;
  }

  // ── 연속(batch) 조회/제어 ───────────────────────────────────────────────
  /** 한 연속의 태스크들(seq 순) */
  async findByBatch(batchId: string): Promise<TaskHistoryDocument[]> {
    return this.taskModel.find({ batchId }).sort({ seq: 1, createdAt: 1 }).exec();
  }
  /** 연속의 반복 플래그 일괄 변경(정지 시 false → 재시작 차단) */
  async setBatchRepeat(batchId: string, repeat: boolean): Promise<void> {
    await this.taskModel.updateMany({ batchId }, { $set: { repeat } });
  }

  // ── 단건 삭제 (DB에서 완전 제거) ─────────────────────────────────────────
  async remove(taskId: string): Promise<void> {
    await this.taskModel.deleteOne({ _id: taskId });
    // 단일소스: 삭제도 백엔드가 브로드캐스트 → 프론트는 목록에서 제거만
    this.events.broadcast('fms_task_deleted', { _id: taskId });
  }

  // ── 전체 초기화 — fms_tasks 컬렉션의 모든 태스크를 DB에서 삭제 (새로 시작용) ──
  async wipeAllTasks(server: Server | null): Promise<number> {
    const res = await this.taskModel.deleteMany({});
    if (server) server.emit('fms_tasks', []);
    this.logger.warn(`[초기화] fms_tasks 전체 삭제 — ${res.deletedCount ?? 0}건`);
    return res.deletedCount ?? 0;
  }

  // ── 글로벌 큐 비우기 — 미배정 대기(PENDING/DRAFT)만 일괄 삭제 ─────────────
  async clearGlobalQueue(server: Server | null): Promise<number> {
    const res = await this.taskModel.deleteMany({
      status: { $in: [TaskStatus.PENDING, TaskStatus.DRAFT] },
    });
    // 삭제 이벤트가 없으므로 전체 목록을 다시 브로드캐스트해 프론트를 DB와 일치시킨다.
    if (server) server.emit('fms_tasks', await this.list({ limit: 200 }));
    this.logger.log(`[글로벌큐] 비움 — ${res.deletedCount ?? 0}건 삭제(PENDING/DRAFT)`);
    return res.deletedCount ?? 0;
  }

  // ── 목록 조회 (recent 기본 / priority면 상태→유형 정렬) ──────────────────
  async list(opts: { status?: string; robot_id?: string; limit?: number; sort?: 'priority' | 'recent'; afterMs?: number } = {}) {
    const filter: Record<string, unknown> = {};
    if (opts.status)   filter.status = opts.status;
    if (opts.robot_id) filter['assignedRobotId'] = opts.robot_id;
    // 기준 시각 이후 등록(createdAt ≥ afterMs)만 — 시간 윈도우 필터(예: 최근 30분)
    if (opts.afterMs && Number.isFinite(opts.afterMs)) filter.createdAt = { $gte: new Date(opts.afterMs) };
    const docs = await this.taskModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(opts.limit ?? 100, 500))
      .lean()
      .exec();
    if (opts.sort === 'priority') {
      sortByPriority(docs);
    }
    return docs;
  }

  async activeCount(): Promise<number> {
    return this.taskModel.countDocuments({
      status: { $in: [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.RUNNING] },
    });
  }
}
