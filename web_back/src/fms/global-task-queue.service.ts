import { Injectable } from '@nestjs/common';
import { CreateTaskDto } from './task.dto';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { TaskHistoryDocument } from './task.schema';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { PathfindingService } from '../pathfinding/pathfinding.service';
import { RobotService } from '../robot/robot.service';
import { RobotStatus } from '../robot/robot.schema';
import { rankRobotsForTask, RobotCandidate } from './robot-priority';

/**
 * 글로벌 태스크 큐 — 태스크 생성/등록/대기 전환만 담당 (실행은 사용자가 직접 한다).
 *
 * 수동 단일명령 모델: 우선순위 자동 소진·자동 재할당는 없다. enqueue(=PENDING) 또는
 * register(=DRAFT)로 만들어 두고, 사용자가 dispatchTask(robotId)로 하나씩 실행한다.
 * 영속 저장은 TaskRepositoryService(Mongo)가 담당한다.
 */
@Injectable()
export class GlobalTaskQueueService {
  constructor(
    private readonly taskRepo:   TaskRepositoryService,
    private readonly taskStatus: TaskStatusService,
    private readonly events:     TaskManagerEventsService,
    private readonly robotState: RobotStateService,
    private readonly robotTasks: RobotTaskQueueService,
    private readonly pathfinding: PathfindingService,
    private readonly robotService: RobotService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  //  ★ 주어진 작업(태스크)에 대한 로봇 우선순위.
  //  - 비교 규칙(온라인/busy/거리)은 robot-priority.ts
  //  - 거리(현재 위치 → 목적지) 계산은 PathfindingService.hopDistanceFromPosition (맵/경로 로직)
  //  여기서는 후보(온라인/busy/배터리)만 모아 거리를 받아 넘긴다.
  // ───────────────────────────────────────────────────────────────────────────
  /** 기존 태스크 기준 추천 — 태스크의 목적지/유형으로 위임. */
  async rankRobotsForTask(taskId: string) {
    const task = await this.taskRepo.getTask(taskId);
    if (!task) return [];
    return this.rankRobotsForTarget(task.targetNode, task.type);
  }

  /**
   * 목적지(+유형) 기준 추천 — 호출 시점의 로봇 상태로 매번 새로 계산한다.
   * (새 태스크 등록 중 등 taskId가 아직 없을 때도 목적지만으로 추천 가능)
   */
  async rankRobotsForTarget(targetNode: string, type?: string) {
    // 로봇 상태(DB 단일 출처) — 오프라인·오류(ERROR)·일시정지(PAUSED)는 후보에서 제외(robot-priority).
    const statusOf = new Map((await this.robotService.findAll()).map((r) => [r.robot_id, r.status]));
    const depths = await this.robotTasks.queueDepths(); // robotId → 큐 깊이(대기+수행중)
    const candidates: RobotCandidate[] = await Promise.all(
      [...this.robotState.entries()].map(async ([robotId, cache]) => ({
        robotId,
        online:     this.robotState.getOnlineState(robotId) === true,
        error:      statusOf.get(robotId) === RobotStatus.ERROR,
        paused:     statusOf.get(robotId) === RobotStatus.PAUSED,
        busy:       this.robotTasks.hasActive(robotId), // 현재 수행 중 — 카드 표시용
        queueLen:   depths.get(robotId) ?? 0,           // 로봇 큐 개수 — 적을수록 우선
        batteryPct: cache.batteryPct ?? null,
        kind:       robotId.replace(/[\d_-].*$/, '') || undefined, // 접두 기반 종류(대략)
        // 현재 위치(최근접 노드) — 카드 표시용
        node:       (cache.posX != null && cache.posY != null) ? await this.pathfinding.findNearestNodeToPosition(cache.posX, cache.posY) : null,
        // 목적지가 있으면 거리 계산, 없으면(충전 등) 거리 미상(null) — 큐·배터리 순으로만 추천
        distance:   targetNode ? await this.pathfinding.hopDistanceFromPosition(cache.posX, cache.posY, targetNode) : null,
      })),
    );
    return rankRobotsForTask(candidates);
  }

  /** 태스크 생성(PENDING) — 실행 대기 목록에 올린다(자동 할당 없음). */
  async enqueue(dto: CreateTaskDto): Promise<TaskHistoryDocument> {
    const task = await this.taskRepo.createQueued(dto);
    this.events.broadcast('fms_task_created', task);
    return task;
  }

  /**
   * 연속 생성 — 한 로봇에게 여러 태스크를 순번(seq)대로 PENDING 생성한다.
   * 실제 실행(첫 태스크 dispatch)은 TaskManagerService가 담당(체인은 dispatchNext가 seq순으로 이어감).
   */
  async enqueueBatch(robotId: string, items: CreateTaskDto[], repeat = false): Promise<TaskHistoryDocument[]> {
    // 같은 연속의 모든 태스크가 공유 — 프론트가 이 값으로 한 카드에 묶어 표시
    const batchId = `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created: TaskHistoryDocument[] = [];
    for (let i = 0; i < items.length; i++) {
      // 연속의 모든 태스크에 로봇 id를 미리 박는다(preferred=배차용, assigned=표시/소속용 단일소스).
      const task = await this.taskRepo.createQueued({ ...items[i], preferredRobotId: robotId, assignedRobotId: robotId, seq: i, batchId, repeat });
      this.events.broadcast('fms_task_created', task);
      created.push(task);
    }
    return created;
  }

  /**
   * 시나리오 생성 — 단건 태스크들을 seq 순서로 PENDING 생성한다. 스텝마다 로봇이 다를 수 있다.
   * 첫 스텝 실행은 TaskManagerService가, 이후 전진(한 스텝 완료→다음)은 RobotTaskQueueService.advanceScenario가 담당.
   */
  async enqueueScenario(steps: CreateTaskDto[]): Promise<TaskHistoryDocument[]> {
    const scenarioId = `SCN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created: TaskHistoryDocument[] = [];
    for (let i = 0; i < steps.length; i++) {
      // 각 스텝의 로봇(preferredRobotId)을 그대로 사용. 표시용으로 assignedRobotId도 미리 박는다.
      const robotId = steps[i].preferredRobotId ?? null;
      const task = await this.taskRepo.createQueued({ ...steps[i], scenarioId, seq: i, assignedRobotId: robotId });
      this.events.broadcast('fms_task_created', task);
      created.push(task);
    }
    return created;
  }

  /** 등록만(DRAFT) — 나중에 release → 실행. */
  async register(dto: CreateTaskDto): Promise<TaskHistoryDocument> {
    const task = await this.taskRepo.createDraft(dto);
    this.events.broadcast('fms_task_created', task);
    return task;
  }

  /** DRAFT → PENDING 으로 전환 (아직 실행 안 됨 — 사용자가 dispatchTask). */
  async release(taskId: string): Promise<TaskHistoryDocument | null> {
    return this.taskStatus.release(taskId, this.events.server);
  }
}
