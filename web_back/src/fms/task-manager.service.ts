import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { CreateTaskDto } from './task.dto';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { TaskStatus, TaskType } from './task.schema';
import { isTerminalStatus } from '../fms-shared/task-manager.helpers';
import { RobotService } from '../robot/robot.service';
import { RobotStatus } from '../robot/robot.schema';
import { TopologyService } from '../topology/topology.service';
import { PathfindingService } from '../pathfinding/pathfinding.service';
import { NodeOccupancyService } from '../node-occupancy/node-occupancy.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from './global-task-queue.service';
import { ChargingService } from './charging.service';
import { TaskExecutionService } from './task-execution.service';
import { NodeLockService } from './node-lock.service';
import { TaskPlannerService } from './task-planner.service';
import { RobotMonitorService } from './robot-monitor.service';
import { AutoDispatcherService } from './auto-dispatcher.service';
import { AutoChargerService } from './auto-charger.service';
import { AutoTaskService } from './auto-task.service';
import { CoreEventBus, CoreEvent } from '../core-events/core-events.service';
import { TaskCatalogService } from '../task-catalog/task-catalog.service';

// 온라인/오프라인·충전 상태 "표시"만 주기적으로 갱신하는 경량 인터벌 (자동 할당/복구 아님)
const STATUS_REFRESH_MS = 2_000;

/**
 * FMS 오케스트레이터(파사드) — 수동 단일명령 모델.
 *
 * 백엔드는 로봇을 자동 선택/스케줄링하지 않는다. 사용자가 robotId를 지정해 한 번에 하나의 동작만
 * 명령한다(노드로 보내기 / 충전소로 보내기 / 공급 / 정지 / 홈복귀 / 초기위치). 이 클래스는
 * (1) 외부(게이트웨이/컨트롤러/AI)용 단일명령 공개 API와 (2) 상태 표시용 경량 주기 갱신만 담당한다.
 *
 * 제거된 자동 동작: 1초 tick 자동할당·AMCL 자동복구·코너 자동회전·오프라인 자동 재할당.
 * (충돌 양보는 1-ahead 우선순위→FIFO 양보로 복원 — TaskExecutionService.checkNodeConflicts)
 */
@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly taskRepo:     TaskRepositoryService,
    private readonly taskStatus:   TaskStatusService,
    private readonly robotService: RobotService,
    private readonly topology:     TopologyService,
    private readonly pathfinding:  PathfindingService,
    private readonly occupancy:    NodeOccupancyService,
    private readonly events:       TaskManagerEventsService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly globalQueue:  GlobalTaskQueueService,
    private readonly charging:     ChargingService,
    private readonly exec:         TaskExecutionService,
    private readonly nodeLock:     NodeLockService,
    private readonly planner:      TaskPlannerService,
    private readonly monitor:      RobotMonitorService,
    private readonly bus:          CoreEventBus,
    private readonly autoDispatcher: AutoDispatcherService,
    private readonly autoCharger:    AutoChargerService,
    private readonly autoTask:       AutoTaskService,
    private readonly catalog:        TaskCatalogService,
  ) {}

  // ── 라이프사이클 ───────────────────────────────────────────────────────────
  // 경량 주기 tick — 온라인/오프라인·충전 상태 갱신 + 충돌 양보(1-ahead) 평가. (자동 배차/충전은 토글 시에만)
  onModuleInit() {
    this.statusTimer = setInterval(() => {
      // 순차 실행: 상태 동기화(전복 ERROR→실패·재등록)를 먼저 끝낸 뒤 자동 디스패치 →
      // 재등록된 태스크가 같은 주기에 바로 로봇 우선순위로 자동 배차된다(다음 주기까지 대기 안 함).
      void (async () => {
        await this.monitor.syncOnlineStatus().catch((e) => this.logger.error('상태 갱신 오류', e));
        await this.exec.checkNodeConflicts().catch((e) => this.logger.error('충돌 양보 평가 오류', e)); // 1-ahead 우선순위→FIFO 양보
        await this.autoTask.refreshIfEnabled().catch((e) => this.logger.error('자동 생성 트리거 갱신 오류', e)); // 트리거 정의 캐시 갱신
        await this.autoDispatcher.runIfEnabled().catch((e) => this.logger.error('자동 디스패처 오류', e));
        await this.autoCharger.runIfEnabled().catch((e) => this.logger.error('자동 충전 오류', e));
      })();
    }, STATUS_REFRESH_MS);
    // 맵 재배정 통지 구독(Map 모듈을 직접 참조하지 않음) → 진행 태스크 정리
    this.bus.on(CoreEvent.ROBOT_MAP_REASSIGNED, ({ robotId }: { robotId: string }) => {
      void this.handleMapChange(robotId).catch((e) => this.logger.error('맵 변경 처리 오류', e));
    });
  }

  // ── 자동 디스패처/자동 충전 (on/off) — 로직은 AutoDispatcherService / AutoChargerService. 여기선 위임만. ──
  // AUTO DISPATCHER는 (1)미배정 태스크 자동 배정 + (2)ROS 데이터 기반 태스크 자동 생성(AutoTaskService)을
  // 한 토글로 함께 켠다 → ROS 조난자 확정 → 구호 태스크 생성 → 디스패처 배정까지 자동으로 이어진다.
  setAutoDispatch(on: boolean): void {
    this.autoDispatcher.setAutoDispatch(on);
    this.autoTask.setEnabled(on); // ROS 데이터 → 태스크 자동 생성도 함께 on/off
  }
  isAutoDispatch(): boolean { return this.autoDispatcher.isAutoDispatch(); }
  setAutoCharge(on: boolean): void { this.autoCharger.setAutoCharge(on); }
  isAutoCharge(): boolean { return this.autoCharger.isAutoCharge(); }

  onModuleDestroy() {
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  setServer(server: Server) {
    this.events.setServer(server);
    this.topology.setServer(server);
    this.occupancy.setServer(server);
  }

  // ── 외부 API: 태스크 (생성 = 단일 명령 1건, 자동 할당 없음) ──────────────────

  /** 태스크 생성(PENDING). 단일명령 모델에선 생성 후 dispatchTask(robotId)로 실행한다. */
  async enqueue(dto: CreateTaskDto) {
    return this.globalQueue.enqueue(dto);
  }

  /** 등록만 — DRAFT 상태로 생성(나중에 release→실행). */
  async register(dto: CreateTaskDto) {
    return this.globalQueue.register(dto);
  }

  /**
   * 연속 등록·실행 — 한 로봇에게 여러 태스크를 seq 순서로 PENDING 생성하고 첫 태스크를 실행한다.
   * 이후 각 태스크 완료 시 RobotTaskQueueService.dispatchNext가 seq 순으로 다음을 이어 실행한다.
   */
  async enqueueBatch(robotId: string, items: CreateTaskDto[], repeat = false) {
    const tasks = await this.globalQueue.enqueueBatch(robotId, items, repeat);
    if (tasks[0]) await this.dispatchTask(String((tasks[0] as any)._id)); // 첫 태스크 착수 → 체인 시작
    return tasks;
  }

  /**
   * 시나리오 등록·실행 — 단건 태스크들을 seq 순서로 생성하고 첫 스텝을 실행한다(스텝마다 로봇 다를 수 있음).
   * 이후 각 스텝 완료 시 RobotTaskQueueService.advanceScenario가 다음 스텝을 dispatch한다.
   */
  async enqueueScenario(steps: CreateTaskDto[]) {
    const tasks = await this.globalQueue.enqueueScenario(steps);
    if (tasks[0]) await this.dispatchTask(String((tasks[0] as any)._id)); // 첫 스텝 착수 → 시나리오 시작
    return tasks;
  }

  /**
   * 저장된 커스텀 시나리오(TaskSequence) 실행 — 정의들을 seq 순 단건 태스크로 인스턴스화하고 첫 스텝부터 시작.
   *  정의에 steps(혼합)가 있으면 rosPlan으로 실어 dispatch가 그대로 실행, 없으면 type+target 경로계산.
   *  단계의 로봇이 비어 있으면(미지정) 기존 추천 랭킹(robot-priority)으로 자동 배정한다.
   */
  async runSequence(seqId: string) {
    const seq = await this.catalog.getSequence(seqId); // populate('items.task')
    const taken = new Set<string>();                   // 같은 시나리오 안에선 단계마다 다른 로봇 우선
    const dtos: CreateTaskDto[] = [];
    for (const it of (seq.items ?? []) as any[]) {
      const def = it.task; // populate 된 Task 정의
      if (!def || !def.type) throw new Error(`시퀀스 항목의 Task 정의 누락 (seq=${it.seq})`);
      let robot: string | null = it.robotId ?? def.preferredRobotId ?? null;
      if (!robot) {
        // 로봇 미지정 → 추천 랭킹 최상위(온라인·정상)를 자동 선택 (사용자의 추천 자동 기능 재사용)
        robot = await this.recommendRobot(def.targetNode, def.type, taken);
        if (!robot) throw new Error(`추천 가능한 로봇이 없습니다 — 단계 "${def.name}" (온라인·정상 로봇 없음)`);
      }
      taken.add(robot);
      dtos.push({
        type:             def.type,
        targetNode:       def.targetNode || undefined,
        preferredRobotId: robot,
        rosPlan:          Array.isArray(def.steps) && def.steps.length ? def.steps : undefined,
      } as CreateTaskDto);
    }
    this.logger.log(`[시나리오 실행] "${(seq as any).name}" — ${dtos.length}단계 (자동배정 ${dtos.filter((d) => d.preferredRobotId).length}건)`);
    return this.enqueueScenario(dtos);
  }

  /**
   * 단일 태스크(Task 정의) 실행 — 정의를 실행 레코드 하나로 인스턴스화하고 즉시 dispatch. (시나리오 아님)
   *  robotId/targetNode 는 실행 파라미터: 미지정 시 정의 기본값, 로봇이 비면 추천 랭킹으로 자동 배정.
   */
  async runTaskDef(defId: string, override: { robotId?: string | null; targetNode?: string } = {}) {
    const def = (await this.catalog.getTaskDef(defId)) as unknown as { name: string; type: TaskType; targetNode?: string; preferredRobotId?: string | null; priority?: number; repeat?: boolean; steps?: unknown[] };
    const targetNode = override.targetNode ?? def.targetNode ?? '';
    let robot: string | null = override.robotId ?? def.preferredRobotId ?? null;
    if (!robot) {
      robot = await this.recommendRobot(targetNode, def.type, new Set());
      if (!robot) throw new Error('추천 가능한 로봇이 없습니다 (온라인·정상 로봇 없음)');
    }
    const task = await this.enqueue({
      label:            def.name,
      type:             def.type,
      targetNode:       targetNode || undefined,
      priority:         def.priority ?? 5,
      repeat:           def.repeat ?? false, // 반복 수행 — 완료 후 restartRepeatCycle이 자동 재시작
      preferredRobotId: robot,
      rosPlan:          Array.isArray(def.steps) && def.steps.length ? (def.steps as CreateTaskDto['rosPlan']) : undefined,
    } as CreateTaskDto);
    await this.dispatchTask(String((task as { _id: unknown })._id));
    this.logger.log(`[태스크 실행] "${def.name}" → ${robot} (${targetNode || '목적지 없음'})`);
    return task;
  }

  /** 로봇 미지정 시 추천 랭킹 최상위 자동 선택 — 온라인·비오류(가능하면 비작업·이미 배정 안 된) 로봇. 공급은 omx 고정. */
  private async recommendRobot(targetNode: string | undefined, type: string, taken: Set<string>): Promise<string | null> {
    if (type === 'SUPPLY') return 'omx'; // 공급은 omx 전용(기존 모델과 동일)
    const ranked = (await this.rankRobotsForTarget(targetNode ?? '', type)) as Array<{ robotId: string; online?: boolean; error?: boolean; busy?: boolean }>;
    const ok = (r: { online?: boolean; error?: boolean }) => !!r.online && !r.error;
    const pick =
      ranked.find((r) => ok(r) && !r.busy && !taken.has(r.robotId)) ?? // 1순위: 온라인·정상·비작업·미배정
      ranked.find((r) => ok(r) && !taken.has(r.robotId)) ??            // 2순위: 미배정
      ranked.find((r) => ok(r));                                       // 3순위: 온라인·정상이면 허용(작업 중이면 큐 대기)
    return pick?.robotId ?? null;
  }

  /** ★ 주어진 태스크에 대한 로봇 우선순위(적합도) 랭킹 — 로직은 robot-priority.ts. */
  rankRobotsForTask(taskId: string) {
    return this.globalQueue.rankRobotsForTask(taskId);
  }

  /** ★ 목적지(+유형) 기준 로봇 추천 — 드롭다운 펼칠 때마다 호출(매번 새 계산). */
  rankRobotsForTarget(targetNode: string, type?: string) {
    return this.globalQueue.rankRobotsForTarget(targetNode, type);
  }

  /**
   * 반복 연속 정지 — 반복 해제 후 비종료(PENDING/RUNNING/ASSIGNED) 태스크를 전부 COMPLETED로 바꿔
   * 로봇 큐에서 빼고 로봇을 IDLE로 종료한다. (재시작 차단 + 즉시 종료)
   */
  async stopBatch(batchId: string) {
    const tasks = await this.taskRepo.findByBatch(batchId);
    if (tasks.length === 0) return { ok: false, message: '연속을 찾을 수 없음' };
    const robotId = tasks[0].preferredRobotId ?? null;
    await this.taskRepo.setBatchRepeat(batchId, false); // 재시작 차단(먼저)
    for (const t of tasks) {
      if (!isTerminalStatus(t.status)) {
        await this.nodeLock.lockNode(t.targetNode, false); // 각 스텝 목적지 잠금 해제 (연속=단건 묶음 → 단건 취소와 동일 정리)
        await this.taskStatus.setStatus(String((t as any)._id), TaskStatus.COMPLETED, this.events.server, { completedAt: new Date() });
      }
    }
    if (robotId) {
      this.robotTasks.clearActive(robotId); // 큐에서 active 제거
      this.occupancy.release(robotId);      // 점유 해제 (단건 취소와 동일)
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
    }
    this.logger.log(`[반복정지] 연속 ${batchId} 종료 — 로봇 ${robotId ?? '?'} IDLE`);
    return { ok: true };
  }

  /** DRAFT → PENDING 으로 올린다(아직 자동 실행 안 됨, 사용자가 dispatchTask). */
  async releaseTask(taskId: string) {
    return this.globalQueue.release(taskId);
  }

  /** 사용자가 지정한 robotId로 태스크 1건을 즉시 실행(수동 할당). */
  async dispatchTask(taskId: string) {
    return this.planner.planTask(taskId);
  }

  /** 일시정지로 보류(SUSPENDED)된 태스크를 그 지점부터 이어서 재개. */
  async resumeTask(taskId: string) {
    return this.planner.resumeTask(taskId);
  }

  /** 충전소에 머무는 로봇 정보(id + 배터리) 조회 — 모니터링용 */
  async getChargerOccupants(mapId: string) {
    return this.charging.getChargerOccupantsInfo(mapId);
  }

  // ── 외부 API: 노드 잠금 (수동 폐쇄/해제 — 표시 전용, 자동 우회 없음) ──────────

  getLockedNodeIds(): Promise<string[]> {
    return this.nodeLock.getLockedNodeIds();
  }

  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    return this.nodeLock.lockNode(nodeId, isLocked);
  }

  // ── 외부 API: 홈/알림 ──────────────────────────────────────────────────────

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.robotState.setHome(robotId, x, y, yaw);
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── 긴급 정지 ──────────────────────────────────────────────────────────────
  // 활성 태스크가 있으면 취소(=정지+IDLE), 없으면 단순 cmd_vel 정지.
  async stopRobot(robotId: string): Promise<{ ok: boolean; message: string }> {
    const taskId = this.robotTasks.getActive(robotId);
    if (taskId) {
      await this.cancelTask(taskId);
      return { ok: true, message: `${robotId} 태스크 취소 및 정지 완료` };
    }
    this.exec.hardStop(robotId);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    return { ok: true, message: `${robotId} 정지 완료 (진행 중 태스크 없음)` };
  }

  // ── 홈 복귀 (단일 명령) ────────────────────────────────────────────────────
  returnHomeNow(robotId: string): { ok: boolean; message: string } {
    const home = this.robotState.getHome(robotId);
    if (!home) {
      return { ok: false, message: `${robotId} 홈 위치가 등록되지 않음 — 맵에서 홈을 먼저 지정하세요` };
    }
    this.exec.returnHome(robotId);
    return { ok: true, message: `${robotId} 홈 복귀 시작 (${home.x.toFixed(2)}, ${home.y.toFixed(2)})` };
  }

  // ── 태스크 취소 + 로봇 즉시 정지 (자동 후속 없음) ──────────────────────────
  async cancelTask(taskId: string): Promise<void> {
    if (!this.events.hasServer) return;
    const server = this.events.server!;

    const task = await this.taskRepo.getTask(taskId);
    if (!task) return;
    if (isTerminalStatus(task.status)) return;

    await this.nodeLock.lockNode(task.targetNode, false);
    const robotId  = task.assignedRobotId;
    const isActive = !!robotId && this.robotTasks.getActive(robotId) === taskId;

    if (robotId && isActive) {
      this.exec.cancelNav(robotId); // 실 터틀봇 navigate_to_pose 액션 취소(있으면)
      // 현재 위치를 새 goal로 덮어써서 nav2의 이전 goal을 즉시 무효화 (TEST-BOT/goal_pose 경로)
      const cache = this.robotState.getCache(robotId);
      if (cache?.posX != null && cache.posY != null) {
        this.exec.publishGoal(robotId, cache.posX, cache.posY, cache.yaw ?? 0);
      }
      this.exec.hardStop(robotId); // cmd_vel=0 (nav2 반응 전 움직임 대비)

      this.robotTasks.clearActive(robotId);
      this.occupancy.release(robotId);
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

      this.events.emit(Alert.info(`${robotId} 태스크 취소 — 현재 위치에서 정지`, { taskId, robotId }));
      this.logger.log(`[취소] ${robotId} 정지 (task: ${taskId})`);
    }

    await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, server, { completedAt: new Date() });
  }

  // ── 맵 전환 시 태스크·위치·캐시 초기화 ────────────────────────────────────
  // 맵이 바뀌면 기존 pathQueue는 구 맵 노드 ID이므로 무효 → 활성 태스크 취소 +
  // robot.lastNode 초기화 + AMCL 위치 캐시 클리어.
  async handleMapChange(robotId: string): Promise<void> {
    const taskId = this.robotTasks.getActive(robotId);
    if (taskId) {
      this.robotTasks.clearActive(robotId);
      if (this.events.hasServer) {
        await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
      } else {
        await this.taskStatus.setStatusDirect(taskId, TaskStatus.FAILED);
      }
      this.logger.log(`[맵변경] ${robotId} → 진행 태스크 취소 (${taskId})`);
    }

    await this.robotService.updateNode(robotId, null);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

    if (this.robotState.getCache(robotId)) {
      this.robotState.patchCache(robotId, { posX: null, posY: null, yaw: null });
    }

    this.occupancy.release(robotId);

    // 진행 중인 nav2 주행 중단 (맵 변경으로 이전 goal_pose/액션 무효)
    this.exec.cancelNav(robotId); // 실 터틀봇 navigate_to_pose 액션 취소(있으면)
    this.exec.publishStop(robotId);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
  }

  // ── 초기위치 설정 + robot.location 즉시 갱신 (단일 명령) ────────────────────
  async setInitialPoseAndLocation(
    robotId: string, x: number, y: number, yaw: number, mapId?: string,
  ): Promise<void> {
    this.exec.publishInitialPose(robotId, x, y, yaw);

    const nearestId = await this.pathfinding.findNearestNodeToPosition(x, y, mapId);
    const updated = await this.robotService.setInitialPose(robotId, mapId ?? null, x, y, yaw, nearestId);
    this.logger.log(`[초기위치] ${robotId} map=${mapId ?? 'null'} location=${nearestId ?? 'null'} (${x.toFixed(2)}, ${y.toFixed(2)})`);
    if (updated) this.events.broadcast('robot_registered', updated.toObject ? updated.toObject() : updated);
  }

  // ── 글로벌 태스크 큐 초기화 (미실행 대기 PENDING/DRAFT 삭제) ─────────────────
  clearGlobalQueue(): Promise<number> {
    return this.taskRepo.clearGlobalQueue(this.events.server);
  }

  // ── 전체 태스크 초기화 (fms_tasks 전부 삭제) ────────────────────────────────
  wipeAllTasks(): Promise<number> {
    return this.taskRepo.wipeAllTasks(this.events.server);
  }
}
