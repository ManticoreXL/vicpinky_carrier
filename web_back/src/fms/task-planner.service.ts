import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { TaskStatus, TaskType, TaskHistoryDocument, RosStep } from './task.schema';
import { RobotService } from '../robot/robot.service';
import { RobotDocument, RobotStatus } from '../robot/robot.schema';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { TopologyService } from '../topology/topology.service';
import { PathfindingService } from '../pathfinding/pathfinding.service';
import { NodeLockService } from './node-lock.service';
import { RosService } from '../ros/ros.service';
import { TaskExecutionService, buildRosPlan, PlanNode } from './task-execution.service';
import { ONLINE_MS, NODE_ARRIVE_M, TEST_ARRIVE_M, SUPPLY_TIMEOUT_MS } from '../fms-shared/task-manager.constants';

// SUPPLY 비전: 허브(49) 발행 → omx(45) 브릿지
const START_TOPIC = '/omx/vision/start_inference';
const LOADED_TOPIC = '/omx/vision/is_loaded';

/**
 * 수동 단건 디스패치 + 유형별 실행 (이전: TaskPlannerService + Nav/Supply 핸들러 + SupplyVision 4분할 → 통합).
 *
 *  planTask(taskId) → 지정 robotId 검증(온라인/비busy) → 유형 분기
 *   - 이동/구호/충전: 경로탐색(resolvePath) → buildRosPlan → TaskExecutionService.startPlan (첫 goal_pose)
 *   - 공급(omx):      vision/start_inference 발행 + /vision/is_loaded 대기(완료=COMPLETED → dispatchNext)
 */
@Injectable()
export class TaskPlannerService implements OnModuleInit {
  private readonly logger = new Logger(TaskPlannerService.name);
  // SUPPLY 적재 대기: robotId → { taskId, timer }
  private readonly supplyPending = new Map<string, { taskId: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly taskRepo:     TaskRepositoryService,
    private readonly taskStatus:   TaskStatusService,
    private readonly robotService: RobotService,
    private readonly robotState:   RobotStateService,
    private readonly events:       TaskManagerEventsService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly topology:     TopologyService,
    private readonly pathfinding:  PathfindingService,
    private readonly nodeLock:     NodeLockService,
    private readonly rosService:   RosService,
    private readonly exec:         TaskExecutionService,
  ) {}

  onModuleInit(): void {
    // SUPPLY 적재 감지 — /vision/is_loaded=true 수신 시 대기 중 SUPPLY 완료
    this.rosService.onMessage((msg) => {
      if (msg.topic !== LOADED_TOPIC) return;
      if ((msg.data as { data?: boolean })?.data === true) void this.onSupplyLoaded();
    });
  }

  // ── 디스패치 진입점 ───────────────────────────────────────────────────────────
  /** 글로벌 큐의 PENDING 태스크 1건을 지정 robotId로 즉시 실행. */
  async planTask(taskId: string): Promise<{ ok: boolean; message: string }> {
    if (!this.events.hasServer) return { ok: false, message: '서버 없음' };

    const task = await this.taskRepo.getTask(taskId);
    if (!task) { this.logger.warn(`[디스패치] 태스크 없음: ${taskId}`); return { ok: false, message: '태스크 없음' }; }
    this.logger.log(`[디스패치] 시도 ${taskId} — type=${task.type}, robot=${task.preferredRobotId ?? '미지정'}, rosPlan=${task.rosPlan?.length ?? 0}스텝, status=${task.status}`);
    if (task.status !== TaskStatus.PENDING) {
      this.logger.warn(`[디스패치] ${taskId} 건너뜀 — 상태가 ${task.status}(PENDING 아님). 큐에서 dispatch는 PENDING만 가능.`);
      return { ok: false, message: `대기(PENDING) 상태가 아님: ${task.status}` };
    }

    const robotId = task.preferredRobotId && task.preferredRobotId !== 'null' ? task.preferredRobotId : null;
    if (!robotId) {
      this.logger.warn(`[디스패치] ${taskId} 보류 — preferredRobotId 미지정(수동 할당은 로봇 필수)`);
      await this.taskStatus.setWaitReason(taskId, '실행할 로봇 미지정 (robotId 필수)');
      return { ok: false, message: '로봇 미지정 — 수동 할당는 robotId가 필수입니다' };
    }
    // 로봇이 이미 수행 중이면 큐 대기(PENDING 유지) — 완료 시 RobotTaskQueueService.dispatchNext가 꺼낸다.
    // 단, 복귀(RECALL)·일시정지(PAUSE)는 선점한다 — 작업 중이어도 즉시 처리한다.
    const preempts = task.type === TaskType.RECALL || task.type === TaskType.PAUSE;
    if (!preempts && this.robotTasks.hasActive(robotId)) {
      this.logger.warn(`[디스패치] ${taskId} 큐 대기 — ${robotId} 이미 작업 중(active=${this.robotTasks.getActive(robotId)}). 그 작업 끝나야 실행됨.`);
      return { ok: true, message: `${robotId} 작업 중 — 큐 대기(PENDING 유지)` };
    }
    // 온라인 확인
    const cache = this.robotState.getCache(robotId);
    if (!cache || Date.now() - cache.lastSeen >= ONLINE_MS) {
      this.logger.warn(`[디스패치] ${taskId} 보류 — ${robotId} 오프라인(최근 수신 ${cache ? `${Math.round((Date.now() - cache.lastSeen) / 1000)}초 전` : '없음'})`);
      await this.taskStatus.setWaitReason(taskId, `로봇 ${robotId} 오프라인 — 재연결 대기`);
      return { ok: false, message: `로봇 ${robotId} 오프라인` };
    }

    const robot = await this.robotService.autoRegister(robotId);
    // 오류(ERROR) 로봇에는 할당 불가 — 복구 후 다른 로봇을 다시 지정해야 한다.
    if (robot.status === RobotStatus.ERROR) {
      this.logger.warn(`[디스패치] ${taskId} 불가 — ${robotId} 오류(ERROR) 상태(복구 후 재지정 필요)`);
      await this.taskStatus.setWaitReason(taskId, `로봇 ${robotId} 오류(ERROR) 상태 — 복구 후 재지정 필요`);
      return { ok: false, message: `로봇 ${robotId} 오류 상태 — 할당 불가` };
    }
    // 커스텀 혼합 스텝(rosPlan)이 박혀 있으면 타입과 무관하게 경로계산 없이 그대로 실행한다.
    //  - PAUSE/RECALL은 예외(선점 동작 우선).
    //  - SUPPLY도 rosPlan이 있으면 커스텀 스텝 우선, 없으면 기존 보급(start_inference) 분기로 폴백.
    const hasCustomPlan = Array.isArray(task.rosPlan) && task.rosPlan.length > 0 && !preempts;
    this.logger.log(`[디스패치] ${robotId} ← ${taskId} 분기=${hasCustomPlan ? `커스텀플랜(${task.rosPlan.length}스텝)` : task.type}`);
    const started =
      hasCustomPlan                 ? await this.handleCustomPlan(robot, task, taskId) :
      task.type === TaskType.PAUSE  ? await this.handlePause(robot, taskId) :
      task.type === TaskType.RECALL ? await this.handleRecall(robot, task, taskId) :
      task.type === TaskType.SUPPLY ? await this.handleSupply(robot, task, taskId) :
                                      await this.handleNav(robot, task, taskId);
    this.logger.log(`[할당] ${robotId} ← ${taskId} (${task.type}) ${started ? '실행' : '실패'}`);
    return { ok: started, message: started ? `${robotId} 실행 시작` : '실행 실패 (경로 없음 등)' };
  }

  // 유형별 주행 중 로봇 상태 (할당·재개 공용) — 이동·구호·공급은 WORKING으로 통합(구체 작업은 활성 태스크에서 파생).
  // 충전은 가는 동안 TO_CHARGE(충전소 이동 중) — 충전소 노드 "도착" 시 completeTask가 CHARGING(충전중)으로 바꾼다.
  private movingStatusFor(type: TaskType): RobotStatus {
    return type === TaskType.CHARGE ? RobotStatus.TO_CHARGE
         : type === TaskType.RECALL ? RobotStatus.RETURNING
         :                            RobotStatus.WORKING;
  }

  // ── 일시정지(PAUSE) — 현재 위치 즉시 정지 + 진행 태스크 SUSPENDED 보류(큐 유지) ────────
  // 진행 중이던 태스크는 active 맵에 그대로 둔 채 SUSPENDED로만 바꿔 "들고 있는 큐"를 보존한다.
  // 재개(resumeTask) 시 그 지점(rosCursor)부터 이어서 주행한다. PAUSE 태스크 자체는 즉시 COMPLETED.
  private async handlePause(robot: RobotDocument, pauseTaskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    this.exec.cancelNav(robotId);  // 실 터틀봇 navigate_to_pose 액션 취소(재개 시 resumePlan이 재전송)
    this.exec.hardStop(robotId);   // cmd_vel=0 — 즉시 정지(이전 goal 무효화)
    this.supplyCancel(robotId);    // 보급 대기 타이머가 있으면 정리

    const heldId = this.robotTasks.getActive(robotId);
    if (heldId && heldId !== pauseTaskId) {
      await this.taskStatus.setStatus(heldId, TaskStatus.SUSPENDED, this.events.server!);
      // active 맵은 비우지 않는다 — 로봇이 이 태스크(+남은 PENDING)를 "들고" 일시정지 상태.
      this.events.emit(Alert.info(`${robotId} 일시정지 — 진행 태스크 보류(재개 대기)`, { robotId, taskId: heldId }));
    } else {
      this.events.emit(Alert.info(`${robotId} 일시정지 (진행 태스크 없음)`, { robotId }));
    }
    await this.robotService.updateStatus(robotId, RobotStatus.PAUSED);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.PAUSED });

    // PAUSE 태스크 자체는 순간 동작 → 즉시 COMPLETED (dispatchNext 호출 안 함: 로봇은 보류 유지)
    await this.taskStatus.setStatus(pauseTaskId, TaskStatus.COMPLETED, this.events.server!, { completedAt: new Date(), assignedRobotId: robotId });
    this.logger.log(`[일시정지] ${robotId} 정지 + 보류(${heldId ?? '없음'})`);
    return true;
  }

  // ── 재개 — 일시정지로 보류(SUSPENDED)된 태스크를 그 지점부터 이어서 주행 ──────────────
  async resumeTask(taskId: string): Promise<{ ok: boolean; message: string }> {
    if (!this.events.hasServer) return { ok: false, message: '서버 없음' };
    const task = await this.taskRepo.getTask(taskId);
    if (!task) return { ok: false, message: '태스크 없음' };
    if (task.status !== TaskStatus.SUSPENDED) return { ok: false, message: `보류(SUSPENDED) 상태가 아님: ${task.status}` };
    const robotId = task.assignedRobotId;
    if (!robotId) return { ok: false, message: '배정 로봇 없음' };

    this.robotTasks.setActive(robotId, taskId);                 // 재시작 등으로 active가 비었어도 복원
    await this.taskStatus.setStatus(taskId, TaskStatus.RUNNING, this.events.server!);
    await this.robotService.updateStatus(robotId, this.movingStatusFor(task.type));
    await this.exec.resumePlan(taskId);                          // 현재 rosCursor 스텝(goal_pose) 재전송 → 주행 재개
    this.events.emit(Alert.info(`${robotId} 재개 — 들고 있던 큐 계속 수행`, { robotId, taskId }));
    this.logger.log(`[재개] ${robotId} → ${taskId} (cursor 지점부터)`);
    return { ok: true, message: `${robotId} 재개` };
  }

  // ── 복귀(RECALL) — 보유 태스크 글로벌 큐 반납 후 현재 맵 초기위치로 이동 ────────────
  private async handleRecall(robot: RobotDocument, task: TaskHistoryDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    // 1) 반납 — 이 로봇이 가진 미완료 태스크(복귀 자신 + 같은 시나리오 형제 스텝 제외)를 글로벌 큐로 되돌림.
    //    (시나리오 안의 복귀는 그 시나리오의 다음 스텝까지 반납하면 안 됨 — advanceScenario가 이어가야 하므로)
    await this.returnRobotTasks(robotId, taskId, task.scenarioId);
    // 2) 복귀 목적지 = 현재 맵(robot.location)의 초기위치 노드(initPosition)
    const mapId = robot.location;
    const initNode = mapId ? await this.topology.findInitPositionNode(mapId) : null;
    if (!initNode) {
      await this.taskStatus.setWaitReason(taskId, `복귀 불가 — 맵(${mapId ?? '미상'})에 초기위치 노드(initPosition) 없음`);
      await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, this.events.server!, { completedAt: new Date() });
      return false;
    }
    task.targetNode = initNode.node_id;
    await this.taskRepo.setTargetNode(taskId, initNode.node_id);

    // 3) 이미 초기위치에 있으면 주행 없이 자동 성공 처리
    const cache = this.robotState.getCache(robotId);
    const arriveM = robotId.startsWith('TEST') ? TEST_ARRIVE_M : NODE_ARRIVE_M;
    const atInit = robot.lastNode === initNode.node_id ||
      (cache?.posX != null && cache.posY != null &&
       Math.hypot(cache.posX - initNode.x, cache.posY - initNode.y) <= arriveM);
    if (atInit) {
      await this.taskStatus.setStatus(taskId, TaskStatus.COMPLETED, this.events.server!, { completedAt: new Date(), assignedRobotId: robotId });
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.emit(Alert.completed(taskId, robotId, `${robotId} 이미 초기위치(${initNode.node_id}) — 복귀 자동 완료`));
      this.logger.log(`[복귀] ${robotId} 이미 초기위치 ${initNode.node_id} → 주행 없이 자동 완료`);
      await this.robotTasks.dispatchNext(robotId);      // 같은 로봇 연속 다음
      await this.robotTasks.advanceScenario(taskId);    // 시나리오면 다음 스텝
      return true;
    }

    // 4) 목적지 확정 후 일반 이동(MOVING)과 동일하게 주행
    this.logger.log(`[복귀] ${robotId} → 초기위치 ${initNode.node_id} (맵 ${mapId})`);
    return this.handleNav(robot, task, taskId);
  }

  // 보유 태스크 반납 — 진행 중 주행 즉시 정지 + 노드 잠금 해제 + PENDING(미배정) 재투입
  // exceptScenarioId: 같은 시나리오의 형제 스텝은 반납에서 제외(시나리오 순서 보존)
  private async returnRobotTasks(robotId: string, exceptTaskId: string, exceptScenarioId?: string | null): Promise<void> {
    const tasks = (await this.taskRepo.findReturnableByRobot(robotId))
      .filter((t) => String(t._id) !== exceptTaskId)
      .filter((t) => !exceptScenarioId || t.scenarioId !== exceptScenarioId);
    this.exec.cancelNav(robotId); // 실 터틀봇 navigate_to_pose 액션 취소(선점/반납)
    this.exec.hardStop(robotId); // 이전 goal 무효화(cmd_vel=0)
    for (const t of tasks) {
      await this.nodeLock.lockNode(t.targetNode, false);
      await this.taskStatus.returnToQueue(String(t._id), this.events.server!);
    }
    this.robotTasks.clearActive(robotId);
    if (tasks.length) {
      this.events.emit(Alert.info(`${robotId} 복귀 — 보유 태스크 ${tasks.length}건 글로벌 큐 반납`, { robotId }));
      this.logger.log(`[복귀] ${robotId} 보유 태스크 ${tasks.length}건 반납`);
    }
  }

  // ── 이동/구호/충전 ────────────────────────────────────────────────────────────
  private async handleNav(robot: RobotDocument, task: TaskHistoryDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    this.logger.log(`[dispatch] ${robotId} 태스크 ${taskId} 배정 | node=${robot.lastNode ?? 'null'} | target=${task.targetNode}`);

    const pathQueue = await this.resolvePath(robot, task, taskId);
    if (pathQueue === null) return false; // 목적지/경로 없음 (waitReason·FAILED는 resolvePath에서 처리)

    const pathNodes: PlanNode[] = [];
    for (const id of pathQueue) {
      const n = await this.topology.findNodeById(id);
      if (n) pathNodes.push({ node_id: id, x: n.x, y: n.y, yaw: n.yaw });
    }
    const plan = buildRosPlan(robotId, task.type, pathNodes);

    this.robotTasks.setActive(robotId, taskId);
    await this.taskStatus.assignToRobot(taskId, robotId, pathQueue, this.events.server!);
    await this.robotService.updateStatus(robotId, this.movingStatusFor(task.type));
    await this.nodeLock.lockNode(task.targetNode, true);

    await this.exec.startPlan(taskId, plan);                 // 첫 goal_pose 전송(이후 도착마다 advance)
    await this.taskStatus.setStatus(taskId, TaskStatus.RUNNING, this.events.server!);

    this.events.emit(Alert.assigned(taskId, robotId,
      `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당 — 경로: [${pathQueue.join('→')}]`));
    return true;
  }

  // ── 커스텀 혼합 스텝 실행 ──────────────────────────────────────────────────────
  // 미리 박힌 rosPlan(move/service/topic/wait)을 경로계산 없이 그대로 실행한다(스텝 = 리터럴).
  // move 스텝은 정의에 명시된 goal_pose/도착노드를 그대로 사용(A* 다중 경유 없음).
  private async handleCustomPlan(robot: RobotDocument, task: TaskHistoryDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    // 스텝의 변수(로봇·목표지점)를 실행 시점 값으로 해석 — robotId 바인딩 + {target}→task.targetNode
    const plan = await Promise.all(task.rosPlan.map((s) => this.resolveStep(s, robotId, task)));
    this.robotTasks.setActive(robotId, taskId);
    await this.taskStatus.setStatus(taskId, TaskStatus.RUNNING, this.events.server!, { assignedRobotId: robotId, startedAt: new Date() });
    await this.robotService.updateStatus(robotId, this.movingStatusFor(task.type));
    if (task.targetNode) await this.nodeLock.lockNode(task.targetNode, true);
    await this.exec.startPlan(taskId, plan);                  // 첫 스텝 전송(이후 완료마다 advance)
    this.events.emit(Alert.assigned(taskId, robotId, `${robotId} ← [${task.type}] 커스텀 스텝 ${plan.length}개 실행`));
    this.logger.log(`[커스텀] ${robotId} ← ${taskId} 커스텀 스텝 ${plan.length}개`);
    return true;
  }

  // 스텝의 변수를 실행 시점 값으로 해석:
  //  - 로봇 바인딩: robot-scoped 종류(move/service/wait)는 topicName 첫 세그먼트를 robotId로 치환. topic 종류는 전역이라 유지.
  //  - {robot} 토큰: topicName·awaitTopic 안의 `{robot}` → robotId (전역 신호 토픽의 로봇 부분 등).
  //  - {target} 노드: move 스텝 awaitNodeId 가 '{target}'이면 task.targetNode 로 해석하고 goal_pose 를 그 노드 좌표로 채움.
  private async resolveStep(step: RosStep, robotId: string, task: TaskHistoryDocument): Promise<RosStep> {
    const kind = step.kind ?? 'move';
    const bind = (t: string) => String(t ?? '').replace(/\{robot\}/g, robotId);
    const suffix = String(step.topicName).replace(/^\/[^/]+\//, ''); // "/<seg>/" 제거 → 나머지
    let awaitNodeId = step.awaitNodeId ?? null;
    let message = step.message ?? {};
    if (awaitNodeId === '{target}') { // 목표지점 파라미터 — 실행 시 task.targetNode 로 해석
      awaitNodeId = task.targetNode || null;
      const n = awaitNodeId ? await this.topology.findNodeById(awaitNodeId) : null;
      if (n) message = { pose: { position: { x: n.x, y: n.y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
    }
    return {
      kind,
      topicName:   kind === 'topic' ? bind(step.topicName) : `/${robotId}/${suffix}`,
      messageType: step.messageType,
      message,
      awaitNodeId,
      awaitKind:   step.awaitKind ?? 'arrival',
      waitMs:      step.waitMs ?? 0,
      awaitTopic:  bind(step.awaitTopic ?? ''),
      awaitField:  step.awaitField ?? '',
      awaitValue:  step.awaitValue ?? null,
      endTopic:    bind(step.endTopic ?? ''),  // 엔드조건 신호 토픽({robot} 치환)
      endField:    step.endField ?? '',
      endValue:    step.endValue ?? null,
    };
  }

  // 경로 해석: 목적지 노드 → 출발 노드(robot.lastNode 우선, 없으면 AMCL 최근접) → A* 경로(pathQueue).
  private async resolvePath(robot: RobotDocument, task: TaskHistoryDocument, taskId: string): Promise<string[] | null> {
    const targetNode = await this.topology.findNodeById(task.targetNode);
    if (!targetNode) {
      await this.taskStatus.setWaitReason(taskId, `목적지 노드 없음: ${task.targetNode}`);
      await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, this.events.server!);
      return null;
    }
    const myMapId = targetNode.map_id;
    const { startNodeId, startFromLocation } = await this.resolveStartNode(robot, task, myMapId);
    return this.planPath(robot, task, taskId, myMapId, startNodeId, startFromLocation);
  }

  private async nearestAmclNode(robotId: string, myMapId: string): Promise<string | null> {
    const cache = this.robotState.getCache(robotId);
    if (cache?.posX != null && cache.posY != null) {
      return this.pathfinding.findNearestNodeToPosition(cache.posX, cache.posY, myMapId);
    }
    return null;
  }

  private async resolveStartNode(robot: RobotDocument, task: TaskHistoryDocument, myMapId: string): Promise<{ startNodeId: string | null; startFromLocation: boolean }> {
    const robotId = robot.robot_id;
    let startNodeId: string | null = null;
    let startFromLocation = false;
    if (robot.lastNode && robot.lastNode !== task.targetNode) {
      const locNode = await this.topology.findNodeById(robot.lastNode);
      if (locNode && locNode.map_id === myMapId) { startNodeId = robot.lastNode; startFromLocation = true; }
    }
    if (!startNodeId) {
      const amclNode = await this.nearestAmclNode(robotId, myMapId);
      if (amclNode) { startNodeId = amclNode; await this.robotService.updateNode(robotId, amclNode); }
    }
    return { startNodeId, startFromLocation };
  }

  private async planPath(robot: RobotDocument, task: TaskHistoryDocument, taskId: string, myMapId: string, startNodeId: string | null, startFromLocation: boolean): Promise<string[] | null> {
    const robotId = robot.robot_id;
    if (!startNodeId || startNodeId === task.targetNode) {
      this.logger.log(`[dispatch] ${robotId} startNode=${startNodeId ?? 'null'} — 목적지 직행 [${task.targetNode}]`);
      return [task.targetNode];
    }
    let rawPath = await this.pathfinding.findPath(startNodeId, task.targetNode, myMapId);
    if (rawPath.length === 0 && startFromLocation) {
      const amclNode = await this.nearestAmclNode(robotId, myMapId);
      if (amclNode && amclNode !== startNodeId) {
        const retry = await this.pathfinding.findPath(amclNode, task.targetNode, myMapId);
        if (retry.length > 0) { startNodeId = amclNode; rawPath = retry; await this.robotService.updateNode(robotId, amclNode); }
      }
    }
    if (rawPath.length === 0) {
      await this.taskStatus.setWaitReason(taskId, `경로 없음: ${startNodeId} → ${task.targetNode}`);
      this.events.emit(Alert.noPath(taskId, robotId, `경로를 찾을 수 없음: ${startNodeId} → ${task.targetNode} — 수동제어가 필요합니다`));
      await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, this.events.server!);
      return null;
    }
    const pathQueue = rawPath.slice(1);
    this.logger.log(`[dispatch] ${robotId} 경로 확정: [${rawPath.join('→')}] queue=[${pathQueue.join('→')}]`);
    return pathQueue;
  }

  // ── 공급(omx) — 비전 적재검증 ─────────────────────────────────────────────────
  private async handleSupply(robot: RobotDocument, task: TaskHistoryDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    this.robotTasks.setActive(robotId, taskId);
    await this.taskStatus.setStatus(taskId, TaskStatus.RUNNING, this.events.server, { assignedRobotId: robotId, startedAt: new Date() });
    await this.robotService.updateStatus(robotId, RobotStatus.WORKING); // 공급도 WORKING(통합) — 구체 작업은 활성 태스크에서 파생
    this.supplyStart(robotId, taskId);
    this.events.emit(Alert.assigned(taskId, robotId, `${robotId} 보급 시작 (${task.targetNode}) — 비전 적재 검증 대기`));
    this.logger.log(`[보급] ${robotId} → ${task.targetNode} 보급 시작 (task ${taskId})`);
    return true; // 적재 확인까지 로봇 점유
  }

  // 추론 시작 발행 + 적재 대기 등록
  private supplyStart(robotId: string, taskId: string): void {
    this.supplyCancel(robotId);
    this.rosService.publish({ topicName: START_TOPIC, messageType: 'std_msgs/msg/Bool', message: { data: true } });
    const timer = setTimeout(() => void this.onSupplyTimeout(robotId), SUPPLY_TIMEOUT_MS);
    this.supplyPending.set(robotId, { taskId, timer });
    this.logger.log(`[보급] ${robotId} 추론 시작 → ${START_TOPIC} (task ${taskId}), is_loaded 대기`);
  }

  // /vision/is_loaded=true → 대기 중 SUPPLY 전부 완료 (omx 1대라 보통 1건)
  private async onSupplyLoaded(): Promise<void> {
    if (this.supplyPending.size === 0) return;
    for (const [robotId, p] of [...this.supplyPending]) {
      clearTimeout(p.timer);
      this.supplyPending.delete(robotId);
      await this.taskStatus.setStatus(p.taskId, TaskStatus.COMPLETED, this.events.server, { completedAt: new Date() });
      this.robotTasks.clearActive(robotId);
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
      this.events.emit(Alert.completed(p.taskId, robotId, `${robotId} 적재됨 — 보급 완료`));
      this.logger.log(`[보급] ${robotId} is_loaded=true → COMPLETED (task ${p.taskId})`);
      await this.robotTasks.dispatchNext(robotId);      // 같은 로봇 다음 PENDING
      await this.robotTasks.advanceScenario(p.taskId);  // 시나리오면 다음 스텝(로봇 무관)
    }
  }

  private async onSupplyTimeout(robotId: string): Promise<void> {
    const p = this.supplyPending.get(robotId);
    if (!p) return;
    this.supplyPending.delete(robotId);
    await this.taskStatus.setStatus(p.taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date(), errorMessage: '비전 적재 미확인 (타임아웃)' });
    this.events.emit(Alert.info(`${robotId} 보급 타임아웃 — 적재 미확인`, { robotId, taskId: p.taskId }));
    this.logger.warn(`[보급] ${robotId} is_loaded 타임아웃 → FAILED (task ${p.taskId})`);
  }

  private supplyCancel(robotId: string): void {
    const p = this.supplyPending.get(robotId);
    if (p) { clearTimeout(p.timer); this.supplyPending.delete(robotId); }
  }
}
