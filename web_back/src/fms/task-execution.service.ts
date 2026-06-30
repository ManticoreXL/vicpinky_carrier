import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaskHistory, TaskHistoryDocument, TaskStatus, TaskType } from './task.schema';
import { isTerminalStatus, getPath } from '../fms-shared/task-manager.helpers';
import { RobotService } from '../robot/robot.service';
import { RobotStatus } from '../robot/robot.schema';
import { TopologyService } from '../topology/topology.service';
import { NodeType } from '../topology/node.schema';
import { NodeOccupancyService } from '../node-occupancy/node-occupancy.service';
import { CollisionAvoidanceService, RobotPathState } from '../collision-avoidance/collision-avoidance.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { TaskRepositoryService } from './task-repository.service';
import { trafficPriority } from './task-priority';
import { TaskStatusService } from './task-status.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { NodeLockService } from './node-lock.service';
import { RosService } from '../ros/ros.service';
import type { ActionResultMsg, RosMessage } from '../ros/ros.types';
import { DomainBridgeService } from '../ros/domain-bridge/domain-bridge.service';
import { Pose, Quaternion } from '../geometry/pose';
import { NODE_PASS_M, NODE_ARRIVE_M, TEST_ARRIVE_M } from '../fms-shared/task-manager.constants';

// ─────────────────────────────────────────────────────────────────────────────
//  ★ 유형별 "ROS로 나가야 할 토픽" 시퀀스 정의 (이 함수만 고치면 됨)
//   - MOVE/PROCESS/CHARGE: 경로 노드마다 goal_pose (각 노드 도착이 완료조건)
//   - SUPPLY(omx): 추론 시작 1스텝 (/vision/is_loaded=true 수신이 완료조건)
// ─────────────────────────────────────────────────────────────────────────────
export interface RosStep {
  kind?: string; // 'move'|'service'|'topic'|'wait'|'supply' (미지정=move)
  topicName: string;
  messageType: string;
  message: Record<string, unknown>;
  awaitNodeId: string | null;
  awaitKind: 'arrival' | 'vision_loaded' | 'none' | 'signal';
  waitMs?: number;
  awaitTopic?: string;   // signal 완료: 신호 토픽(`{robot}` 토큰 치환됨)
  awaitField?: string;   // signal 완료: 비교 필드(dot-path)
  awaitValue?: unknown;  // signal 완료: 기대값(null=truthy/존재만)
  endTopic?: string;     // 엔드조건: 기본 완료 후 기다릴 외부 신호 토픽(`{robot}` 치환). 빈값=없음
  endField?: string;     // 엔드조건: 비교 필드(dot-path)
  endValue?: unknown;    // 엔드조건: 기대값(null=truthy/존재만)
}
export interface PlanNode { node_id: string; x: number; y: number; yaw?: number | null; }
// 전송 대상 스텝 — 런타임 빌드(RosStep) / DB 저장(rosPlan) 둘 다 수용하는 구조적 타입.
type PlanStep = { kind?: string; topicName: string; messageType: string; message: Record<string, unknown>; awaitNodeId: string | null; awaitKind: string; waitMs?: number; awaitTopic?: string; awaitField?: string; awaitValue?: unknown; endTopic?: string; endField?: string; endValue?: unknown };

// ── 커스텀 스텝 빌더 (서비스/액션/토픽/대기 — 시퀀스/프론트가 이걸로 스텝 리스트 구성) ──
/** 서비스 호출 스텝: 응답이 완료조건. success=false 또는 결과조건(awaitField=awaitValue) 불일치면 FAILED. */
export function serviceStep(robotId: string, serviceName: string, serviceType: string, request: Record<string, unknown>, awaitField = '', awaitValue: unknown = null): RosStep {
  return { kind: 'service', topicName: serviceName.startsWith('/') ? serviceName : `/${robotId}/${serviceName}`, messageType: serviceType, message: request, awaitNodeId: null, awaitKind: 'none', awaitField, awaitValue };
}
/** 액션 스텝: 액션 goal 전송 → result 가 완료조건. ABORTED/CANCELED 또는 결과조건 불일치면 FAILED. */
export function actionStep(robotId: string, actionName: string, actionType: string, goal: Record<string, unknown>, awaitField = '', awaitValue: unknown = null): RosStep {
  return { kind: 'action', topicName: actionName.startsWith('/') ? actionName : `/${robotId}/${actionName}`, messageType: actionType, message: goal, awaitNodeId: null, awaitKind: 'none', waitMs: 0, awaitField, awaitValue };
}
/** 토픽 발행 스텝: 발행 즉시 다음 스텝. */
export function topicStep(topicName: string, messageType: string, message: Record<string, unknown>): RosStep {
  return { kind: 'topic', topicName, messageType, message, awaitNodeId: null, awaitKind: 'none' };
}
/** 대기 스텝: waitMs 후 다음 스텝. (robotId는 추적용 — topicName에 담는다) */
export function waitStep(robotId: string, waitMs: number): RosStep {
  return { kind: 'wait', topicName: `/${robotId}/_wait`, messageType: '', message: {}, awaitNodeId: null, awaitKind: 'none', waitMs };
}
/** 신호 대기 스텝: awaitTopic 에 (awaitField=awaitValue) 신호가 오면 완료(=다음 실행/마지막이면 태스크 성공). */
export function signalWaitStep(robotId: string, awaitTopic: string, awaitField = '', awaitValue: unknown = null): RosStep {
  return { kind: 'wait', topicName: `/${robotId}/_wait`, messageType: '', message: {}, awaitNodeId: null, awaitKind: 'signal', waitMs: 0, awaitTopic, awaitField, awaitValue };
}

function goalPoseStep(robotId: string, n: PlanNode): RosStep {
  const now = Date.now() / 1000;
  return {
    kind: 'move',
    topicName: `/${robotId}/goal_pose`,
    messageType: 'geometry_msgs/PoseStamped',
    message: {
      header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
      pose: { position: { x: n.x, y: n.y, z: 0 }, orientation: Quaternion.fromYaw(n.yaw ?? 0).toObject() },
    },
    awaitNodeId: n.node_id,
    awaitKind: 'arrival',
  };
}

export function buildRosPlan(robotId: string, type: TaskType, pathNodes: PlanNode[]): RosStep[] {
  if (type === TaskType.SUPPLY) {
    return [{
      kind: 'supply',
      topicName: `/${robotId}/vision/start_inference`,
      messageType: 'std_msgs/Bool',
      message: { data: true },
      awaitNodeId: null,
      awaitKind: 'vision_loaded',
    }];
  }
  return pathNodes.map((n) => goalPoseStep(robotId, n));
}

/**
 * 태스크 실행(주행) 통합 서비스 — "ROS 발행 + 시퀀스 전송 + 도착 판정/완료 + 저수준 주행 명령"을 한곳에.
 *
 * (이전: NavigationService + RosPlanService + NavPublishService + NavGoalService 4분할 → 통합)
 *  - 발행: publishGoal / publishStop / publishInitialPose
 *  - 시퀀스: startPlan(미리 계산한 rosPlan을 DB 저장 + 첫 스텝) / advance(완료마다 다음 스텝)
 *  - 도착: onAmclPose → checkWaypointArrival → 최종이면 completeTask, 아니면 advance
 *  - 명령: returnHome / hardStop
 */
@Injectable()
export class TaskExecutionService implements OnModuleInit {
  private readonly logger = new Logger(TaskExecutionService.name);
  private readonly waypointProcessing = new Set<string>(); // amcl_pose 중복 처리 방지
  // 실 터틀봇(tb3): 노드마다 navigate_to_pose 액션 — robotId → 현재 진행 중 goalId(취소/완료 추적)
  private readonly activeNavGoal = new Map<string, string>();
  // wait 스텝 진행 타이머 — robotId → timer(취소용)
  private readonly activeWait = new Map<string, NodeJS.Timeout>();
  // signal 대기 — robotId → 기다리는 신호 조건(완료 시 다음/태스크 성공). 한 로봇당 1개.
  private readonly activeSignal = new Map<string, { topic: string; field: string; value: unknown; taskId: string }>();
  // 액션 스텝 — robotId → 진행 중 액션(이름+goalId). 결과(result)로 완료 판정. 취소 추적용.
  private readonly activeActionGoal = new Map<string, { name: string; goalId: string }>();

  // 신호 기반 완료 — rosbridge 수신 메시지를 받아 활성 signal 대기와 매칭.
  onModuleInit(): void {
    this.rosService.onMessage((msg) => this.onSignal(msg));
  }

  // 도착 판정 방식 분기: 실 터틀봇(tb3)=navigate_to_pose 액션 result / TEST-BOT=goal_pose+amcl 임계.
  // (가상 테스트봇은 nav2가 없고 goal_pose를 가로채 amcl을 주입하므로 액션을 쓰지 않는다)
  private usesNavAction(robotId: string): boolean { return robotId.startsWith('tb3'); }
  private navActionName(robotId: string): string { return `/${robotId}/navigate_to_pose`; }

  /** 진행 중 nav 액션 + wait 타이머 취소 (정지/취소/맵변경/일시정지 시). */
  cancelNav(robotId: string): void {
    const goalId = this.activeNavGoal.get(robotId);
    if (goalId) {
      this.rosService.cancelActionGoal(this.navActionName(robotId), goalId);
      this.activeNavGoal.delete(robotId);
      this.logger.log(`[nav] ${robotId} navigate_to_pose 취소 [${goalId}]`);
    }
    const waitTimer = this.activeWait.get(robotId);
    if (waitTimer) { clearTimeout(waitTimer); this.activeWait.delete(robotId); }
    this.activeSignal.delete(robotId); // 신호 대기도 취소
    const act = this.activeActionGoal.get(robotId); // 진행 중 액션 스텝도 취소
    if (act) { this.rosService.cancelActionGoal(act.name, act.goalId); this.activeActionGoal.delete(robotId); }
  }

  constructor(
    @InjectModel(TaskHistory.name) private readonly taskModel: Model<TaskHistoryDocument>,
    private readonly rosService:   RosService,
    private readonly domainBridge: DomainBridgeService,
    private readonly taskRepo:     TaskRepositoryService,
    private readonly taskStatus:   TaskStatusService,
    private readonly robotService: RobotService,
    private readonly topology:     TopologyService,
    private readonly occupancy:    NodeOccupancyService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly events:       TaskManagerEventsService,
    private readonly nodeLock:     NodeLockService,
    private readonly collision:    CollisionAvoidanceService,
  ) {}

  // ── ROS 발행 ────────────────────────────────────────────────────────────────
  publishGoal(robotId: string, x: number, y: number, yaw: number): void {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName: `/${robotId}/goal_pose`,
      messageType: 'geometry_msgs/PoseStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: { position: { x, y, z: 0 }, orientation: Quaternion.fromYaw(yaw).toObject() },
      },
    });
  }

  publishStop(robotId: string): void {
    const { topic, stamped } = this.cmdVelTarget(robotId);
    const zero = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
    this.rosService.publish({
      topicName: topic,
      messageType: stamped ? 'geometry_msgs/TwistStamped' : 'geometry_msgs/Twist',
      message: stamped ? { header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' }, twist: zero } : zero,
    });
  }

  publishInitialPose(robotId: string, x: number, y: number, yaw: number): void {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName: `/${robotId}/initialpose`,
      messageType: 'geometry_msgs/PoseWithCovarianceStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          pose: { position: { x, y, z: 0 }, orientation: Quaternion.fromYaw(yaw).toObject() },
          covariance: [
            0.25, 0, 0, 0, 0, 0,  0, 0.25, 0, 0, 0, 0,  0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,  0, 0, 0, 0, 0, 0,  0, 0, 0, 0, 0, 0.068,
          ],
        },
      },
    });
  }

  /** cmd_vel 발행 대상(타입/토픽) 결정 — domain_bridge 참조, 기본은 비-stamped. */
  private cmdVelTarget(robotId: string): { topic: string; stamped: boolean } {
    const caps = this.domainBridge.getCapabilities(robotId);
    if (caps && !Array.isArray(caps)) {
      const entry = caps.commands.find((c) =>
        c.hubTopic === `/${robotId}/cmd_vel` || c.hubTopic === '/cmd_vel' || c.robotTopic === '/cmd_vel');
      if (entry) return { topic: entry.hubTopic, stamped: /TwistStamped/.test(entry.type) };
    }
    return { topic: `/${robotId}/cmd_vel`, stamped: false };
  }

  // ── 저수준 주행 명령 ──────────────────────────────────────────────────────────
  /** cmd_vel=0 정지 3회 (nav2 반응 전 확실한 정지) */
  hardStop(robotId: string): void {
    for (let i = 0; i < 3; i++) this.publishStop(robotId);
  }

  /** 등록된 홈 위치로 복귀 (미등록 시 무시) */
  returnHome(robotId: string): void {
    const home = this.robotState.getHome(robotId);
    if (!home) return;
    this.publishGoal(robotId, home.x, home.y, home.yaw);
    this.events.emit(Alert.info(`${robotId} 홈 복귀 중`, { robotId }));
  }

  // ── 충돌 양보 (1-ahead, 유형 우선순위→FIFO) — CollisionAvoidanceService 위임 ──────────
  //
  // 활성(RUNNING) 로봇들의 '다음 노드'(pathQueue[0]) 하나만 평가한다(두 단계 앞 아님).
  // 같은 노드를 점유/노리는 더 우선(유형 우선순위 → 태스크 받은 시각↑ → robotId)인 로봇이 있으면
  // 낮은 쪽을 정지(양보)시키고, 우선권을 확보하면 재출발시킨다. 주기 tick(TaskManagerService)에서 호출.
  // 트래픽 우선권은 큐 정렬과 동일한 TYPE_PRIORITY(trafficPriority)를 단일 출처로 사용 — 통일.
  async checkNodeConflicts(): Promise<void> {
    if (!this.events.hasServer) return;

    const taskOf = new Map<string, string>(); // robotId → 활성 taskId (재출발 시 현재 스텝 재전송용)
    const states: RobotPathState[] = [];
    for (const [robotId, taskId] of [...this.robotTasks.activeEntries()]) {
      const task = await this.taskRepo.getTask(taskId);
      if (!task || isTerminalStatus(task.status) || task.status === TaskStatus.SUSPENDED) continue; // 종료·일시정지 제외
      taskOf.set(robotId, taskId);
      const cache = this.robotState.getCache(robotId);
      const startedAt = task.startedAt ?? (task as { createdAt?: Date }).createdAt;
      states.push({
        robotId,
        pathQueue: task.pathQueue ?? [],
        posX:     cache?.posX ?? null,
        posY:     cache?.posY ?? null,
        priority: trafficPriority(task), // 유형 우선순위(TYPE_PRIORITY) 기반 — 큐 정렬과 통일
        order:    startedAt ? new Date(startedAt).getTime() : 0, // 태스크 착수 시각 = 받은 순(FIFO)
      });
    }
    if (states.length === 0) return;

    for (const d of await this.collision.evaluate(states)) {
      if (d.action === 'stop') {
        this.cancelNav(d.robotId); // 실 터틀봇 navigate_to_pose 취소(테스트봇은 no-op)
        this.hardStop(d.robotId);  // cmd_vel=0 — 즉시 정지(테스트봇은 moving=false)
        this.events.emit(Alert.info(`${d.robotId} 양보 정지 — ${d.conflictNode} 점유 중 (우선: ${d.blockerId})`, { robotId: d.robotId }));
      } else { // resume — 정지했던 지점(현재 스텝 = 다음 노드)으로 재출발
        const taskId = taskOf.get(d.robotId);
        if (taskId) await this.resumePlan(taskId);
      }
    }
  }

  // ── ROS 출력 시퀀스 (미리 계산 → 저장 → 완료마다 순차 전송) ────────────────────
  /** rosPlan/rosCursor=0 + pathQueue/fullPath 저장 + 첫 스텝 전송. (PlanStep = 런타임 빌드/DB rosPlan 둘 다 수용) */
  async startPlan(taskId: string, plan: PlanStep[]): Promise<boolean> {
    if (plan.length === 0) return false;
    const nodes = this.awaitNodes(plan);
    await this.taskModel.updateOne({ _id: taskId }, { $set: { rosPlan: plan, rosCursor: 0, pathQueue: nodes, fullPath: nodes } });
    this.sendStep(taskId, plan[0]);
    this.events.server?.emit('fms_task_updated', { _id: taskId, pathQueue: nodes, fullPath: nodes });
    this.logger.log(`[plan] ${taskId} 시작 — ${plan.length}스텝 (첫: ${plan[0].topicName})`);
    return true;
  }

  /** 재개 — 현재 rosCursor 스텝(goal_pose)을 다시 전송해 정지했던 지점부터 주행 재개. */
  async resumePlan(taskId: string): Promise<boolean> {
    const task = await this.taskModel.findById(taskId);
    if (!task || task.rosPlan.length === 0) return false;
    const cursor = Math.min(task.rosCursor, task.rosPlan.length - 1);
    this.sendStep(taskId, task.rosPlan[cursor]);
    this.logger.log(`[plan] ${taskId} 재개 — 스텝 ${cursor} 재전송 (${task.rosPlan[cursor].topicName})`);
    return true;
  }

  /** 현재 스텝 완료 → 커서++ → 다음 스텝 전송. 더 있으면 true, 플랜 종료면 false. */
  async advance(taskId: string): Promise<boolean> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return false;
    const next = task.rosCursor + 1;
    if (next >= task.rosPlan.length) return false;
    const remaining = this.awaitNodes(task.rosPlan.slice(next));
    await this.taskModel.updateOne({ _id: taskId }, { $set: { rosCursor: next, pathQueue: remaining } });
    this.sendStep(taskId, task.rosPlan[next]);
    this.events.server?.emit('fms_task_updated', { _id: taskId, rosCursor: next, pathQueue: remaining }); // 현재 스텝 표시 갱신
    return true;
  }

  private awaitNodes(plan: { awaitNodeId: string | null }[]): string[] {
    return plan.map((s) => s.awaitNodeId).filter((n): n is string => !!n);
  }

  // 스텝 전송 — kind별 분기: service(서비스)/wait(대기)/topic(발행)/move(노드 주행). move는 실봇=액션/테스트봇=goal_pose.
  private sendStep(taskId: string, step: PlanStep): void {
    const robotId = step.topicName.match(/^\/([^/]+)\//)?.[1] ?? '';
    const kind = step.kind ?? 'move';
    if (kind === 'service') { this.sendServiceStep(taskId, robotId, step); return; }
    if (kind === 'action')  { this.sendActionStep(taskId, robotId, step); return; }
    if (kind === 'wait')    { this.sendWaitStep(taskId, robotId, step); return; }
    if (kind === 'topic')   {
      this.rosService.publish({ topicName: step.topicName, messageType: step.messageType, message: this.withFreshStamp(step.message) });
      this.logger.log(`[step] ${robotId} topic ${step.topicName}`);
      void this.stepCompleted(taskId, robotId, step); // 발행 후 엔드조건 있으면 대기, 없으면 즉시 진행
      return;
    }
    // move / supply — 실 터틀봇 도착 스텝이면 navigate_to_pose 액션, 그 외(TEST-BOT goal_pose / SUPPLY 비전)는 토픽 발행.
    if (step.awaitKind === 'arrival' && step.awaitNodeId && this.usesNavAction(robotId)) {
      this.sendNavGoal(taskId, robotId, step);
      return;
    }
    this.rosService.publish({ topicName: step.topicName, messageType: step.messageType, message: this.withFreshStamp(step.message) });
    this.logger.log(`[plan] 전송 ${step.topicName} (${step.messageType})`);
  }

  // ── 비-이동 스텝 (service / topic / wait) ──────────────────────────────────────
  /** 서비스 호출 스텝 — 응답 수신 시 완료. success=false거나 결과조건(awaitField=awaitValue) 불일치면 FAILED. */
  private sendServiceStep(taskId: string, robotId: string, step: PlanStep): void {
    this.logger.log(`[step] ${robotId} service ${step.topicName} (${step.messageType})`);
    this.rosService.callService(
      { serviceName: step.topicName, serviceType: step.messageType, request: step.message },
      (res) => { void this.onServiceResult(taskId, robotId, step, res); },
    );
  }

  private async onServiceResult(taskId: string, robotId: string, step: PlanStep, res: unknown): Promise<void> {
    if (!this.events.hasServer) return;
    const task = await this.taskRepo.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) return;
    if (this.robotTasks.getActive(robotId) !== taskId) return;
    if (task.status === TaskStatus.SUSPENDED) return;
    const r = (res ?? {}) as { success?: boolean; message?: string };
    if (r.success === false) { // 서비스가 명시적 실패 보고 → 태스크 FAILED
      await this.failTask(robotId, taskId, `서비스 실패 (${step.topicName})${r.message ? `: ${r.message}` : ''}`);
      return;
    }
    // 결과값 조건 — 응답의 특정 필드가 기대값과 일치해야 완료(아니면 FAILED)
    if (step.awaitField && !this.signalMatches(res, step.awaitField, step.awaitValue ?? null)) {
      await this.failTask(robotId, taskId, `서비스 결과 불일치 (${step.topicName}: ${step.awaitField})`);
      return;
    }
    await this.stepCompleted(taskId, robotId, step); // 응답 OK → 엔드조건 있으면 대기, 없으면 진행
  }

  // ── 액션 스텝 (action) — 액션 goal 전송 → result로 완료 판정(결과값 조건 매칭 지원) ──────
  private sendActionStep(taskId: string, robotId: string, step: PlanStep): void {
    const goalId = this.rosService.sendActionGoal(
      { actionName: step.topicName, actionType: step.messageType, goal: step.message },
      undefined,
      (res) => { void this.onActionStepResult(taskId, robotId, step, res); },
    );
    this.activeActionGoal.set(robotId, { name: step.topicName, goalId });
    this.logger.log(`[step] ${robotId} action ${step.topicName} [${goalId}]`);
  }

  private async onActionStepResult(taskId: string, robotId: string, step: PlanStep, res: ActionResultMsg): Promise<void> {
    if (this.activeActionGoal.get(robotId)?.goalId === res.goalId) this.activeActionGoal.delete(robotId);
    if (!this.events.hasServer) return;
    const task = await this.taskRepo.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) return;
    if (this.robotTasks.getActive(robotId) !== taskId) return;
    if (task.status === TaskStatus.SUSPENDED) return;
    if (res.status === 4 || res.status === 5) { // ABORTED/CANCELED → 실패
      await this.failTask(robotId, taskId, `액션 실패 (${step.topicName}, status=${res.status})`);
      return;
    }
    // 결과값 조건 — 액션 result 의 특정 필드가 기대값과 일치해야 완료(아니면 FAILED)
    if (step.awaitField && !this.signalMatches(res.result, step.awaitField, step.awaitValue ?? null)) {
      await this.failTask(robotId, taskId, `액션 결과 불일치 (${step.topicName}: ${step.awaitField})`);
      return;
    }
    await this.stepCompleted(taskId, robotId, step); // result OK → 엔드조건 있으면 대기, 없으면 진행
  }

  /** 대기 스텝 — 신호(awaitKind='signal')면 신호 수신까지, 아니면 waitMs 후 다음(또는 완료). cancelNav로 취소. */
  private sendWaitStep(taskId: string, robotId: string, step: PlanStep): void {
    if (step.awaitKind === 'signal') { this.registerSignalAwait(taskId, robotId, step); return; }
    const ms = Math.max(0, step.waitMs ?? 0);
    this.logger.log(`[step] ${robotId} wait ${ms}ms`);
    const t = setTimeout(() => { this.activeWait.delete(robotId); void this.advanceOrComplete(taskId, robotId); }, ms);
    this.activeWait.set(robotId, t);
  }

  // ── 신호 기반 완료 (awaitKind='signal') ────────────────────────────────────────
  /** 신호 대기 등록 — awaitTopic 에 (awaitField=awaitValue) 신호가 오면 onSignal 이 완료 처리. */
  private registerSignalAwait(taskId: string, robotId: string, step: PlanStep): void {
    const topic = (step.awaitTopic ?? '').trim();
    if (!topic) { void this.advanceOrComplete(taskId, robotId); return; } // 토픽 미지정 → 즉시 진행(설정 오류 방지)
    this.activeSignal.set(robotId, { topic, field: step.awaitField ?? '', value: step.awaitValue ?? null, taskId });
    this.rosService.subscribe(topic); // 실 rosbridge 수신용 (테스트는 injectMessage 로 주입)
    this.logger.log(`[step] ${robotId} signal 대기 ${topic}${step.awaitField ? ` (${step.awaitField}=${JSON.stringify(step.awaitValue)})` : ''}`);
  }

  // 수신 메시지 → 활성 signal 대기와 매칭되면 그 스텝 완료(다음/태스크 성공).
  private onSignal(msg: RosMessage): void {
    if (this.activeSignal.size === 0) return;
    for (const [robotId, w] of this.activeSignal) {
      if (w.topic !== msg.topic) continue;
      if (!this.signalMatches(msg.data, w.field, w.value)) continue;
      this.activeSignal.delete(robotId);
      this.logger.log(`[signal] ${robotId} 신호 수신 ${msg.topic} → 진행`);
      void this.advanceOrComplete(w.taskId, robotId);
    }
  }

  // 메시지 매칭: field 없으면 수신만으로 완료 / value 없으면 truthy / 있으면 느슨한 동등(숫자·문자 혼용 허용).
  private signalMatches(data: unknown, field: string, value: unknown): boolean {
    if (!field) return true;
    const actual = getPath(data, field);
    if (value === null || value === undefined) return !!actual;
    return actual === value || String(actual) === String(value);
  }

  /** 스텝 1차(기본) 완료 → 엔드조건(endTopic)이 있으면 그 신호까지 기다렸다 진행, 없으면 즉시 진행/완료.
   *  (topic 발행 직후 / service·action 결과조건 통과 후 / move 노드 도착 후 공통 호출.) */
  private async stepCompleted(taskId: string, robotId: string, step: PlanStep): Promise<void> {
    const endTopic = (step.endTopic ?? '').trim();
    if (!endTopic) { await this.advanceOrComplete(taskId, robotId); return; }
    if (!this.events.hasServer) return;
    const task = await this.taskRepo.getTask(taskId);
    if (!task || isTerminalStatus(task.status) || task.status === TaskStatus.SUSPENDED) return;
    if (this.robotTasks.getActive(robotId) !== taskId) return;
    // 엔드조건 신호 대기 등록 — 신호가 오면 onSignal 이 advanceOrComplete 로 진행시킨다(cancelNav 시 해제).
    this.activeSignal.set(robotId, { topic: endTopic, field: step.endField ?? '', value: step.endValue ?? null, taskId });
    this.rosService.subscribe(endTopic);
    this.logger.log(`[step] ${robotId} 엔드조건 대기 ${endTopic}${step.endField ? ` (${step.endField}=${JSON.stringify(step.endValue)})` : ''}`);
  }

  /** 비-이동 스텝 완료 → 마지막이면 태스크 완료, 아니면 다음 스텝 전송. */
  private async advanceOrComplete(taskId: string, robotId: string): Promise<void> {
    if (!this.events.hasServer) return;
    const task = await this.taskRepo.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) return;
    if (this.robotTasks.getActive(robotId) !== taskId) return;
    if (task.status === TaskStatus.SUSPENDED) return;
    if (this.isLastStep(task)) await this.completeGeneric(taskId, robotId);
    else await this.advance(taskId);
  }

  private isLastStep(task: { rosCursor: number; rosPlan: unknown[] }): boolean {
    return task.rosCursor >= task.rosPlan.length - 1;
  }

  /** 비-이동 마지막 스텝 완료 → 로봇 현재 노드/위치 기준으로 태스크 완료. */
  private async completeGeneric(taskId: string, robotId: string): Promise<void> {
    const task = await this.taskRepo.getTask(taskId);
    if (!task) return;
    const robot = await this.robotService.findById(robotId);
    const lastNode = robot?.lastNode ?? '';
    const node = lastNode ? await this.topology.findNodeById(lastNode) : null;
    const cache = this.robotState.getCache(robotId);
    const x = cache?.posX ?? node?.x ?? 0;
    const y = cache?.posY ?? node?.y ?? 0;
    const yaw = cache?.yaw ?? node?.yaw ?? 0;
    await this.completeTask(robotId, taskId, task.targetNode, lastNode, x, y, yaw, node?.type === NodeType.CHARGER);
  }

  // 실 터틀봇 — 노드 1개를 navigate_to_pose 액션 goal로 전송. 도착/실패는 result(onNavResult)로 판정.
  private sendNavGoal(taskId: string, robotId: string, step: PlanStep): void {
    const pose = (step.message as { pose?: Record<string, unknown> }).pose ?? {};
    const now = Math.floor(Date.now() / 1000);
    const goalId = this.rosService.sendActionGoal(
      {
        actionName: this.navActionName(robotId),
        actionType: 'nav2_msgs/action/NavigateToPose',
        goal: { pose: { header: { stamp: { sec: now, nanosec: 0 }, frame_id: 'map' }, pose } },
      },
      undefined,
      (res) => { void this.onNavResult(taskId, robotId, step.awaitNodeId, res); },
    );
    this.activeNavGoal.set(robotId, goalId);
    this.logger.log(`[nav] ${robotId} → navigate_to_pose ${step.awaitNodeId} [${goalId}]`);
  }

  // navigate_to_pose 결과 → 노드 도착(SUCCEEDED=3) / 실패(ABORTED=4) 판정. (실 터틀봇 전용)
  private async onNavResult(taskId: string, robotId: string, nodeId: string | null, res: ActionResultMsg): Promise<void> {
    if (this.activeNavGoal.get(robotId) === res.goalId) this.activeNavGoal.delete(robotId);
    if (!this.events.hasServer) return;

    const task = await this.taskRepo.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) return;        // 이미 종료
    if (this.robotTasks.getActive(robotId) !== taskId) return; // 취소/선점됨
    if (task.status === TaskStatus.SUSPENDED) return;          // 일시정지 — 보류(재개 대기)

    if (res.status === 4) { // ABORTED — nav2 실패(장애물/경로없음/타임아웃) → 태스크 FAILED
      await this.failTask(robotId, taskId, `navigate_to_pose ABORTED${nodeId ? ` @ ${nodeId}` : ''}`);
      return;
    }
    if (res.status !== 3) return; // CANCELED(5)/기타 — 무시(의도된 취소 등)

    // SUCCEEDED(3) — 노드 도착
    if (!nodeId) { await this.advance(taskId); return; }
    const node = await this.topology.findNodeById(nodeId);
    if (!node) { this.logger.warn(`[nav] ${robotId} 도착 노드 "${nodeId}" 없음 — 다음 스텝`); await this.advance(taskId); return; }

    await this.robotService.updateNode(robotId, nodeId);
    this.occupancy.occupy(robotId, nodeId);

    // 엔드조건(도착 + 외부 신호)이 걸린 move면 신호까지 기다렸다 진행/완료
    const curStep = task.rosPlan[task.rosCursor] as PlanStep | undefined;
    if (curStep?.endTopic) { await this.stepCompleted(taskId, robotId, curStep); return; }

    const isFinal = this.isLastStep(task); // rosPlan 마지막 스텝이면 완료 (혼합 스텝 플랜 호환)
    if (isFinal) {
      await this.completeTask(robotId, taskId, task.targetNode, nodeId, node.x, node.y, node.yaw ?? 0, node.type === NodeType.CHARGER);
    } else {
      await this.advance(taskId); // 다음 스텝 전송(sendStep 분기: 다음이 move/service/wait/topic)
    }
  }

  // nav 실패(ABORTED 등) → 태스크 FAILED + 글로벌 큐 반납(새 PENDING 미배정) + 로봇 IDLE + 알림.
  // 자동 재할당은 auto-dispatch ON일 때만(기본 OFF → 반납분은 큐에서 수동 dispatch 대기).
  private async failTask(robotId: string, taskId: string, reason: string): Promise<void> {
    this.cancelNav(robotId);
    this.robotTasks.clearActive(robotId);
    this.occupancy.release(robotId);
    const task = await this.taskRepo.getTask(taskId);
    if (task?.targetNode) await this.nodeLock.lockNode(task.targetNode, false);
    await this.taskStatus.setStatus(taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date(), errorMessage: reason, rosCursor: task?.rosCursor ?? 0 }); // errorMessage는 DB 저장용, rosCursor로 실패 단계 표시
    // 실패 작업을 글로벌 큐에 반납 — 원본은 위에서 FAILED로 이력 보존하고, 같은 내용의 새 PENDING(미배정)으로 재등록한다.
    // (robot-monitor.releaseRobotTasks 의 RUNNING 반납과 공유: taskRepo.requeueFailedCopy)
    if (task) await this.taskRepo.requeueFailedCopy(task);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
    this.events.emit(Alert.taskFailed(taskId, robotId, `${robotId} 주행 실패 (${reason}) — 작업을 글로벌 큐에 반납했습니다`));
    this.logger.warn(`[nav실패] ${robotId} task ${taskId} → FAILED (${reason}) → 글로벌 큐 반납`);
  }

  private withFreshStamp(message: Record<string, unknown>): Record<string, unknown> {
    const header = message?.header as { stamp?: { sec: number; nanosec: number } } | undefined;
    if (header?.stamp) return { ...message, header: { ...header, stamp: { sec: Math.floor(Date.now() / 1000), nanosec: 0 } } };
    return message;
  }

  // ── amcl_pose → 도착 판정 (노드 단위 진행) ────────────────────────────────────
  onAmclPose(robotId: string, x: number, y: number, yaw: number): void {
    void this.checkWaypointArrival(robotId, x, y, yaw);
  }

  async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number): Promise<void> {
    if (this.usesNavAction(robotId)) return; // 실 터틀봇은 navigate_to_pose result로 도착 판정(amcl 임계 미사용)
    if (this.waypointProcessing.has(robotId)) return;
    this.waypointProcessing.add(robotId);
    try {
      const taskId = this.robotTasks.getActive(robotId);
      if (!taskId || !this.events.hasServer) return;

      const task = await this.taskRepo.getTask(taskId);
      if (task && task.status === TaskStatus.SUSPENDED) return; // 일시정지 — 진행 보류(active 유지, 재개 대기)
      if (!task || isTerminalStatus(task.status)) {
        this.robotTasks.clearActive(robotId);
        return;
      }

      const remaining = [...(task.pathQueue ?? [])];
      if (remaining.length === 0) return;

      const nextId = remaining[0];
      const node = await this.topology.findNodeById(nextId);
      if (!node) {
        this.logger.warn(`[웨이포인트] ${robotId} 다음 노드 "${nextId}" DB에 없음 — 스텝 건너뜀`);
        await this.advance(taskId);
        return;
      }

      const isFinal = remaining.length === 1;
      const dist = new Pose(x, y).distanceTo(node);
      const threshold = await this.computeArrivalThreshold(robotId, node, nextId, isFinal);
      if (dist > threshold) return;

      await this.robotService.updateNode(robotId, nextId);
      this.occupancy.occupy(robotId, nextId);

      // 엔드조건(도착 + 외부 신호)이 걸린 move면 신호까지 기다렸다 진행/완료
      const curStep = task.rosPlan[task.rosCursor] as PlanStep | undefined;
      if (curStep?.endTopic) { await this.stepCompleted(taskId, robotId, curStep); return; }

      if (isFinal) {
        await this.completeTask(robotId, taskId, task.targetNode, nextId, x, y, yaw, node.type === NodeType.CHARGER);
        return;
      }
      await this.advance(taskId);
    } finally {
      this.waypointProcessing.delete(robotId);
    }
  }

  // 적응형 통과 임계값(좁은 맵 노드 건너뜀 방지). 테스트봇은 정확 스냅이라 최소값.
  private async computeArrivalThreshold(robotId: string, node: { x: number; y: number }, nextId: string, isFinal: boolean): Promise<number> {
    if (robotId.startsWith('TEST')) return TEST_ARRIVE_M;
    if (isFinal) return NODE_ARRIVE_M;
    let threshold = NODE_PASS_M;
    const robot = await this.robotService.findById(robotId);
    const fromId = robot?.lastNode;
    if (fromId && fromId !== nextId) {
      const fromNode = await this.topology.findNodeById(fromId);
      if (fromNode) threshold = Math.min(NODE_PASS_M, Math.max(0.15, new Pose(fromNode.x, fromNode.y).distanceTo(node) * 0.15));
    }
    return threshold;
  }

  // 최종 노드 도착 → 완료 (충전소면 CHARGING, 그 외 IDLE). 완료 후 같은 로봇 다음 PENDING 착수.
  private async completeTask(robotId: string, taskId: string, targetNode: string, arrivedNode: string, x: number, y: number, yaw: number, atCharger = false): Promise<void> {
    this.robotTasks.clearActive(robotId);
    await this.taskStatus.setStatus(taskId, TaskStatus.COMPLETED, this.events.server, { completedAt: new Date(), assignedRobotId: robotId });
    await this.robotService.updateStatus(robotId, atCharger ? RobotStatus.CHARGING : RobotStatus.IDLE);
    if (!atCharger) {
      await this.nodeLock.lockNode(arrivedNode, false);
      this.occupancy.release(robotId);
    }
    this.events.emit(Alert.completed(taskId, robotId, `${robotId} 태스크 완료 (${targetNode})`));
    this.publishInitialPose(robotId, x, y, yaw);
    await this.robotTasks.dispatchNext(robotId);     // 같은 로봇 연속 다음
    await this.robotTasks.advanceScenario(taskId);   // 시나리오면 다음 스텝(로봇 무관)
  }
}
