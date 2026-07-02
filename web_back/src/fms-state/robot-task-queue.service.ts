import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaskHistory, TaskHistoryDocument, TaskStatus } from '../fms/task.schema';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
// 타입만 import(런타임 소거) — 값으로 import하면 task-planner.service ↔ 이 서비스가 순환 import되어 DI가 깨짐.
import type { TaskPlannerService } from '../fms/task-planner.service';

// lean() 조회 결과(평범한 객체) — 큐 정렬/재시작에 필요한 필드만.
type LeanTask = { _id: unknown; task_id?: string; batchId?: string | null; scenarioId?: string | null; seq?: number; status: TaskStatus };

/**
 * 로봇별 태스크 큐 — "태스크 간 순차 실행"을 한곳에서 담당.
 *
 * 큐에 들어가는 상태는 RUNNING(active 1건) + PENDING(대기)뿐. COMPLETED/FAILED는 큐에서 빠진다.
 * 1) 활성 추적: 로봇은 한 번에 1개 태스크만 수행(robotId → 실행 중 taskId). 착수 시 setActive, 종료 시 clearActive.
 * 2) 다음 실행: 현재 RUNNING 완료(clearActive) → dispatchNext가 그 로봇 PENDING 중 seq 최소(FIFO)를 실행.
 * 3) 반복 연속: PENDING이 없고 repeat=true 연속이 한 사이클(전부 COMPLETED) 끝났으면 PENDING으로 리셋·재시작.
 *
 * (TaskPlannerService는 ModuleRef로 지연 해석 — dispatch→supplyHandler→supplyVision 순환 회피)
 */
@Injectable()
export class RobotTaskQueueService {
  private readonly logger = new Logger(RobotTaskQueueService.name);
  private readonly active = new Map<string, string>(); // robotId → 실행 중 taskId

  constructor(
    @InjectModel(TaskHistory.name) private readonly taskModel: Model<TaskHistoryDocument>,
    private readonly events: TaskManagerEventsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── 활성(실행 중) 추적 ─────────────────────────────────────────────────────
  getActive(robotId: string): string | undefined { return this.active.get(robotId); }
  hasActive(robotId: string): boolean { return this.active.has(robotId); }
  setActive(robotId: string, taskId: string): void { this.active.set(robotId, taskId); }
  clearActive(robotId: string): void { this.active.delete(robotId); }

  /** robotId → 활성 taskId 전체 스냅샷 순회용 */
  activeEntries(): IterableIterator<[string, string]> { return this.active.entries(); }

  /**
   * 로봇별 큐 깊이(robotId → 개수) — 대기(PENDING) + 현재 수행중(active 1건).
   * 로봇 셀렉션의 "큐가 적은 로봇 우선" 정렬에 사용. dispatchNext의 큐 정의(PENDING+active)와 일치.
   */
  async queueDepths(): Promise<Map<string, number>> {
    const rows = await this.taskModel.aggregate<{ _id: string; n: number }>([
      { $match: { status: TaskStatus.PENDING, preferredRobotId: { $ne: null } } },
      { $group: { _id: '$preferredRobotId', n: { $sum: 1 } } },
    ]);
    const depths = new Map<string, number>(rows.map((r) => [String(r._id), r.n]));
    for (const robotId of this.active.keys()) depths.set(robotId, (depths.get(robotId) ?? 0) + 1); // 수행중 1건 가산
    return depths;
  }

  // ── 다음 실행 (태스크 간 순차) ─────────────────────────────────────────────
  /** 로봇 큐에서 다음 1건 실행 — PENDING 중 seq 최소(FIFO). 없으면 반복 연속 재시작 시도. */
  async dispatchNext(robotId: string): Promise<void> {
    if (this.hasActive(robotId)) return; // 아직 수행 중이면 대기
    // 시나리오(scenarioId) 스텝은 per-robot 체인이 아니라 advanceScenario가 순서대로 전진시키므로 제외.
    let next: LeanTask | null = await this.taskModel
      .findOne({ status: TaskStatus.PENDING, preferredRobotId: robotId, scenarioId: null })
      .sort({ seq: 1, createdAt: 1 }) // 연속 순번(seq) 우선, 그다음 등록순(FIFO)
      .lean<LeanTask>()
      .exec();
    if (!next) next = await this.restartRepeatCycle(robotId); // 반복 연속 한 사이클 끝 → 재시작
    if (!next) return;
    this.logger.log(`[큐] ${robotId} 다음 태스크 실행 → ${next.task_id ?? ''}`);
    await this.planner().planTask(String(next._id));
  }

  // 호출 시점(모든 모듈 로드 후) 지연 require — 정적 import 순환 회피
  private planner(): TaskPlannerService {
    const { TaskPlannerService } =
      require('../fms/task-planner.service') as typeof import('../fms/task-planner.service');
    return this.moduleRef.get(TaskPlannerService, { strict: false });
  }

  // ── 시나리오 전진 (로봇 무관 순차) ─────────────────────────────────────────
  /** 방금 완료된 태스크가 시나리오 스텝이면, 같은 scenarioId의 다음 PENDING 스텝(seq 순)을 dispatch. */
  async advanceScenario(completedTaskId: string): Promise<void> {
    const done = await this.taskModel.findById(completedTaskId).lean<LeanTask>().exec();
    if (!done?.scenarioId) return; // 시나리오 스텝이 아님
    const next = await this.taskModel
      .findOne({ scenarioId: done.scenarioId, status: TaskStatus.PENDING })
      .sort({ seq: 1, createdAt: 1 }) // 남은 스텝 중 seq 최소 = 다음 스텝
      .lean<LeanTask>()
      .exec();
    if (!next) { this.logger.log(`[시나리오] ${done.scenarioId} 전체 완료`); return; }
    this.logger.log(`[시나리오] ${done.scenarioId} 다음 스텝 → ${next.task_id ?? ''}`);
    await this.planner().planTask(String(next._id));
  }

  // ── 반복 연속 재시작 ───────────────────────────────────────────────────────
  /** repeat=true 연속이 한 사이클(전부 COMPLETED) 끝났으면 PENDING으로 리셋하고 첫 태스크 반환. 아니면 null. */
  private async restartRepeatCycle(robotId: string): Promise<LeanTask | null> {
    const tasks = await this.taskModel
      .find({ preferredRobotId: robotId, repeat: true })
      .sort({ seq: 1, createdAt: 1 })
      .lean<LeanTask[]>()
      .exec();
    if (tasks.length === 0) return null;
    // 한 사이클이 완전히 끝났을 때만(전부 COMPLETED) 재시작. 하나라도 미완/실패면 멈춘다.
    if (!tasks.every((t) => t.status === TaskStatus.COMPLETED)) return null;
    const ids = tasks.map((t) => String(t._id));
    await this.taskModel.updateMany(
      { _id: { $in: ids } },
      { $set: { status: TaskStatus.PENDING, rosCursor: 0, pathQueue: [], assignedRobotId: null, startedAt: null, completedAt: null, errorMessage: null } },
    );
    // UI 리셋 브로드캐스트 — 연속 카드가 다시 진행 0부터 표시되도록
    for (const t of tasks) {
      this.events.broadcast('fms_task_updated', { _id: String(t._id), status: TaskStatus.PENDING, pathQueue: [], assignedRobotId: null, completedAt: null });
    }
    this.logger.log(`[반복] ${robotId} 연속 ${(tasks[0] as { batchId?: string }).batchId ?? ''} 재시작 (${tasks.length}단계)`);
    return { ...tasks[0], status: TaskStatus.PENDING };
  }
}
