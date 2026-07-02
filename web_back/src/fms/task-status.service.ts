import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import { TaskHistory, TaskHistoryDocument, TaskStatus } from './task.schema';
import { isTerminalStatus } from '../fms-shared/task-manager.helpers';

/**
 * 태스크 상태/생명주기 전이 — setStatus·assign·running·release·cancel 등.
 * 모든 전이는 DB를 바꾸고 `fms_task_updated`(또는 목록)로 프론트에 브로드캐스트한다.
 * 순수 CRUD/조회는 TaskRepositoryService.
 */
@Injectable()
export class TaskStatusService {
  private readonly logger = new Logger(TaskStatusService.name);

  constructor(
    @InjectModel(TaskHistory.name) private readonly taskModel: Model<TaskHistoryDocument>,
  ) {}

  // ── 상태 변경 (공용) ──────────────────────────────────────────────────────
  async setStatus(
    taskId: string,
    status: TaskStatus,
    server: Server | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { status, ...extra });
    server?.emit('fms_task_updated', { _id: taskId, status, ...extra });
  }

  // ── 소켓 없이 상태만 변경 (맵변경 등) ─────────────────────────────────────
  async setStatusDirect(taskId: string, status: TaskStatus): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { status });
  }

  // ── 그룹(연속/시나리오) 잔여 스텝 일괄 FAILED ─────────────────────────────
  // 한 스텝이 실패/이탈하면 중간이 빠져 순서를 이어갈 수 없으므로 미완료 형제 전체를 종료한다.
  // (task-execution.failTask · robot-monitor.releaseRobotTasks 공용)
  /** 미완료(터미널 아님) 스텝을 모두 FAILED 처리하고 그 문서들을 반환한다 — 노드 잠금 해제 등 후처리는 호출측. */
  async failGroupRemainder(
    field: 'batchId' | 'scenarioId',
    groupId: string,
    reason: string,
    server: Server | null,
    exceptTaskId?: string,
  ): Promise<TaskHistoryDocument[]> {
    const tasks = await this.taskModel.find({ [field]: groupId }).sort({ seq: 1, createdAt: 1 }).exec();
    const failed: TaskHistoryDocument[] = [];
    for (const t of tasks) {
      if (String(t._id) === exceptTaskId || isTerminalStatus(t.status)) continue;
      await this.setStatus(String(t._id), TaskStatus.FAILED, server, { completedAt: new Date(), errorMessage: reason });
      failed.push(t);
    }
    return failed;
  }

  // ── 대기 이유 갱신 ────────────────────────────────────────────────────────
  async setWaitReason(taskId: string, reason: string): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { waitReason: reason });
  }

  // ── DRAFT → PENDING 할당 큐 투입 ──────────────────────────────────────────
  async release(taskId: string, server: Server | null): Promise<TaskHistoryDocument | null> {
    const task = await this.taskModel.findById(taskId);
    if (!task || task.status !== TaskStatus.DRAFT) return null;
    await this.setStatus(taskId, TaskStatus.PENDING, server);
    this.logger.log(`태스크 할당: ${task.task_id} [${task.type}→${task.targetNode}] DRAFT → PENDING`);
    return task;
  }

  // ── 로봇 할당 + 상태 ASSIGNED ─────────────────────────────────────────────
  async assignToRobot(
    taskId: string,
    robotId: string,
    pathQueue: string[],
    server: Server,
  ): Promise<void> {
    const startedAt = new Date();
    await this.taskModel.updateOne(
      { _id: taskId },
      {
        $set: {
          status:          TaskStatus.ASSIGNED,
          startedAt,
          pathQueue,
          fullPath:        pathQueue,
          assignedRobotId: robotId,
        },
        $unset: { waitReason: '' },
      },
    );
    server.emit('fms_task_updated', {
      _id: taskId,
      status: TaskStatus.ASSIGNED,
      startedAt,
      pathQueue,
      fullPath:        pathQueue,
      assignedRobotId: robotId,
      waitReason: null,
    });
  }

  // ── RUNNING 전환 ──────────────────────────────────────────────────────────
  async setRunning(taskId: string, server: Server): Promise<void> {
    await this.setStatus(taskId, TaskStatus.RUNNING, server);
  }

  // ── pathQueue 갱신 (waypoint 이동 후) ─────────────────────────────────────
  async updatePathQueue(taskId: string, remaining: string[], server: Server, newFullPath?: string[]): Promise<void> {
    const update: Record<string, unknown> = { pathQueue: remaining };
    if (newFullPath) update.fullPath = newFullPath;
    await this.taskModel.updateOne({ _id: taskId }, update);
    const patch: Record<string, unknown> = { _id: taskId, pathQueue: remaining };
    if (newFullPath) patch.fullPath = newFullPath;
    server.emit('fms_task_updated', patch);
  }

  // ── 복귀 반납 — 로봇 배정 해제 + PENDING 으로 글로벌 큐 복귀 ──────────────
  // 복귀(RECALL)를 받은 로봇이 보유하던 태스크를 글로벌 큐로 되돌린다.
  // preferredRobotId 까지 비워 "임의 배정" 상태로 만들어 다른 로봇이 가져갈 수 있게 한다.
  async returnToQueue(taskId: string, server: Server | null): Promise<void> {
    await this.taskModel.updateOne(
      { _id: taskId },
      {
        $set: {
          status:           TaskStatus.PENDING,
          assignedRobotId:  null,
          preferredRobotId: null,
          pathQueue:        [],
          fullPath:         [],
          rosPlan:          [],
          rosCursor:        0,
        },
        $unset: { startedAt: '', completedAt: '', errorMessage: '', waitReason: '' },
      },
    );
    server?.emit('fms_task_updated', {
      _id: taskId, status: TaskStatus.PENDING,
      assignedRobotId: null, preferredRobotId: null, pathQueue: [], fullPath: [],
    });
  }

  // ── 취소 (종료 상태가 아니면 FAILED 처리) ────────────────────────────────
  async cancel(taskId: string, server: Server | null): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return;
    if (isTerminalStatus(task.status)) return;
    await this.setStatus(taskId, TaskStatus.FAILED, server, { completedAt: new Date() });
  }

  // ── DRAFT/PENDING 태스크에 로봇 지정 + 할당 가능(PENDING)으로 (카드의 "할당") ──
  async prepareForDispatch(taskId: string, robotId: string): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return;
    task.preferredRobotId = robotId;
    if (task.status === TaskStatus.DRAFT) task.status = TaskStatus.PENDING;
    await task.save();
  }
}
