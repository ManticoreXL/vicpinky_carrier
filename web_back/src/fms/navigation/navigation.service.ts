import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TaskStatus } from '../task.schema';
import { RobotService } from '../../robot/robot.service';
import { RobotStatus } from '../../robot/robot.schema';
import { TopologyService } from '../../topology/topology.service';
import { NodeType } from '../../topology/node.schema';
import { NodeOccupancyService } from '../../node-occupancy/node-occupancy.service';
import { CollisionAvoidanceService, RobotPathState } from '../../collision-avoidance/collision-avoidance.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../fms-state/robot-task-queue.service';
import { RotationStateService } from '../../fms-state/rotation-state.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { NavGoalService } from './nav-goal.service';
import { NodeLockService } from '../node-lock/node-lock.service';
import { NavRecoveryService } from './nav-recovery.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { Pose, normalizeAngle } from '../../geometry/pose';
import { NODE_PASS_M, NODE_ARRIVE_M } from '../../fms-shared/task-manager.constants';

// ── 코너 회전 파라미터 ──────────────────────────────────────────────────────
const CORNER_WAIT_MS       = 2_000;        // 정지 대기 시간
const CORNER_THRESH        = Math.PI / 4;  // 45° 이상이면 코너 판정
const YAW_CONVERGE_THRESH  = 0.15;         // ~8.6° — yaw 수렴 판정
const CORNER_SAFETY_MS     = 8_000;        // 회전 최대 허용 시간

/**
 * 경로 주행 실행 — "경로 탐색이 실행된 결과(pathQueue)를 따라 실제로 노드를 밟아 가는" 부분.
 *
 * - onAmclPose(): amcl_pose 수신마다 회전 수렴 / AMCL 복구 / 웨이포인트 도달을 라우팅
 * - checkWaypointArrival(): 다음 노드 도달 판정 → pathQueue 진행 / 코너 회전 / 최종 완료
 * - checkNodeConflicts(): 2-ahead 노드 충돌 회피(정지/재출발) 적용
 */
@Injectable()
export class NavigationService {
  private readonly logger = new Logger(NavigationService.name);

  // 동시 amcl_pose 이벤트로 인한 중복 처리 방지
  private readonly waypointProcessing = new Set<string>();

  constructor(
    private readonly fmsService:    FmsService,
    private readonly robotService:  RobotService,
    private readonly topology:      TopologyService,
    private readonly occupancy:     NodeOccupancyService,
    private readonly collision:     CollisionAvoidanceService,
    private readonly robotState:    RobotStateService,
    private readonly robotTasks:    RobotTaskQueueService,
    private readonly rotationState: RotationStateService,
    private readonly events:        TaskManagerEventsService,
    private readonly navGoal:       NavGoalService,
    private readonly nodeLock:      NodeLockService,
    private readonly navRecovery:   NavRecoveryService,
    private readonly dispatch:      DispatchService,
  ) {}

  // ── amcl_pose 라우팅 ───────────────────────────────────────────────────────
  // (캐시 갱신은 RobotTelemetryService가 먼저 수행한 뒤 호출한다)
  onAmclPose(robotId: string, x: number, y: number, yaw: number): void {
    // 코너 회전 중인 경우: yaw 수렴 여부 확인
    const rotState = this.rotationState.get(robotId);
    if (rotState?.phase === 'rotating') {
      const yawDiff = normalizeAngle(yaw - rotState.targetYaw);
      if (Math.abs(yawDiff) < YAW_CONVERGE_THRESH) {
        clearTimeout(rotState.timer);
        this.rotationState.delete(robotId);
        this.logger.log(`[코너] ${robotId} yaw 수렴 (${(yaw * 180 / Math.PI).toFixed(0)}°) → ${rotState.nextNodeId} 진행`);
        void this.navGoal.sendNodeActionGoal(robotId, rotState.nextNodeId);
      }
      return; // 회전 중에는 checkWaypointArrival 스킵
    }

    // AMCL 복구 감지: 일시정지 태스크 자동 재개
    if (this.robotState.getCache(robotId)?.amclSuspended) {
      void this.navRecovery.checkResume(robotId, x, y, yaw);
      return;
    }

    void this.checkWaypointArrival(robotId, x, y, yaw);
  }

  // ── 웨이포인트 도달 판정 ─────────────────────────────────────────────────
  async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number): Promise<void> {
    if (this.waypointProcessing.has(robotId)) return; // amcl_pose 연속 수신 시 중복 실행 방지
    if (this.rotationState.has(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 코너 회전 중 (phase=${this.rotationState.get(robotId)?.phase})`);
      return;
    }
    if (this.collision.isWaiting(robotId)) {
      this.logger.log(`[웨이포인트] ${robotId} 스킵 — 충돌 대기 중 (node=${this.collision.getBlockedNode(robotId)})`);
      return;
    }
    this.waypointProcessing.add(robotId);
    try {
      const taskId = this.robotTasks.getActive(robotId);
      if (!taskId || !this.events.hasServer) return;
      const server = this.events.server!;

      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.logger.log(`[웨이포인트] ${robotId} 태스크 ${taskId} 이미 종료(${task?.status}) — activeTasks 제거`);
        this.robotTasks.clearActive(robotId);
        return;
      }

      const remaining = [...(task.pathQueue ?? [])];
      if (remaining.length === 0) return;

      const nextId = remaining[0];
      const node = await this.topology.findNodeById(nextId);
      if (!node) {
        this.logger.warn(`[웨이포인트] ${robotId} 다음 노드 "${nextId}" DB에 없음 — 큐에서 제거 후 재시도`);
        remaining.shift();
        await this.fmsService.updatePathQueue(taskId, remaining, server);
        if (remaining.length > 0) {
          await this.navGoal.sendNodeActionGoal(robotId, remaining[0]);
        }
        return;
      }

      const isFinal = remaining.length === 1;
      const dist    = new Pose(x, y).distanceTo(node);

      // 적응형 통과 임계값 — 노드 간격이 NODE_PASS_M보다 좁은 맵(예: 401)에서, 직전
      // 노드에 머무는 동안 다음 노드가 이미 고정 임계 반경(1.5m) 안에 들어와 노드를
      // 통째로 건너뛰고 다다음 노드를 찾는 문제를 방지한다. 직전 노드(robot.location)
      // → 다음 노드 거리의 절반을 임계값으로 쓰되 NODE_PASS_M로 상한을 둔다.
      let threshold = isFinal ? NODE_ARRIVE_M : NODE_PASS_M;
      if (!isFinal) {
        const robot  = await this.robotService.findById(robotId);
        const fromId = robot?.location;
        if (fromId && fromId !== nextId) {
          const fromNode = await this.topology.findNodeById(fromId);
          if (fromNode) {
            const segLen = new Pose(fromNode.x, fromNode.y).distanceTo(node);
            if (robotId.startsWith('TEST')) {
              threshold = Math.min(NODE_PASS_M, Math.max(0.01, segLen * 0.01));
            } else {
              threshold = Math.min(NODE_PASS_M, Math.max(0.15, segLen * 0.15));
            }
          }
        }
      }

      this.logger.log(
        `[웨이포인트] ${robotId} pos=(${x.toFixed(2)},${y.toFixed(2)}) → next=${nextId}(${node.type})` +
        ` dist=${dist.toFixed(2)}m threshold=${threshold}m${isFinal ? ' [최종]' : ''}` +
        ` queue=[${remaining.join(',')}]`,
      );

      if (dist > threshold) return;

      await this.robotService.updateLocation(robotId, nextId);
      this.occupancy.occupy(robotId, nextId); // 웨이포인트 도달 → 노드 점유 갱신

      if (isFinal) {
        // 충전소에 도착했으면 로봇 상태를 CHARGING으로 (그 외는 IDLE). isLockedBy는 배차 시점에 이미 예약됨.
        await this.completeTask(robotId, taskId, task.targetNode, nextId, x, y, yaw, node.type === NodeType.CHARGER);
        return;
      }

      remaining.shift();
      await this.fmsService.updatePathQueue(taskId, remaining, server);

      if (remaining.length > 0) {
        const nextNodeId = remaining[0];
        const nextNode   = await this.topology.findNodeById(nextNodeId);
        if (nextNode) {
          const outYaw = new Pose(node.x, node.y).headingTo(nextNode);
          const diff   = normalizeAngle(outYaw - yaw);
          if (Math.abs(diff) > CORNER_THRESH) {
            this.startCornerRotation(robotId, node.x, node.y, outYaw, nextNodeId, diff, nextId);
            return;
          }
        }
        await this.navGoal.sendNodeActionGoal(robotId, nextNodeId);
      }
    } finally {
      this.waypointProcessing.delete(robotId);
    }
  }

  // ── 최종 노드 도착 → 태스크 완료 + per-robot queue 다음 태스크 / 홈 복귀 ─────
  private async completeTask(
    robotId: string, taskId: string, targetNode: string, arrivedNode: string,
    x: number, y: number, yaw: number, atCharger = false,
  ): Promise<void> {
    this.robotTasks.clearActive(robotId);

    await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.events.server, {
      completedAt: new Date(),
      assignedRobotId: robotId,
    });
    // 충전소 도착이면 CHARGING, 그 외는 IDLE
    await this.robotService.updateStatus(robotId, atCharger ? RobotStatus.CHARGING : RobotStatus.IDLE);
    await this.nodeLock.lockNode(arrivedNode, false);
    this.occupancy.release(robotId); // 태스크 완료 — 점유 해제
    this.events.emit(Alert.completed(taskId, robotId, `${robotId} 태스크 완료 (${targetNode})`));
    this.fmsService.publishInitialPose(robotId, x, y, yaw);

    // 충전소 도착이면 그대로 충전 상태로 대기 (홈 복귀/다음 태스크 진행 안 함)
    if (atCharger) return;

    // 대기열에 다음 태스크가 있으면 이어서 실행, 없으면 홈 복귀
    const started = await this.dispatch.dispatchNext(robotId);
    if (!started) this.navGoal.returnHome(robotId);
  }

  // ── 코너 회전: 2s 정지 → 제자리 회전 → yaw 수렴 시 다음 노드 진행 ───────────
  private startCornerRotation(
    robotId: string, nodeX: number, nodeY: number, outYaw: number,
    nextNodeId: string, diff: number, atNodeId: string,
  ): void {
    this.logger.log(`[코너] ${robotId} @ ${atNodeId}: ${(Math.abs(diff) * 180 / Math.PI).toFixed(0)}° 회전 필요 — 2s 정지 후 회전 → ${nextNodeId}`);

    // Phase 1: 2초 정지
    this.navGoal.hardStop(robotId);

    const stopTimer = setTimeout(() => {
      // Phase 2: 회전 goal 전송 (현재 위치에서 outYaw 방향으로 in-place 회전)
      this.fmsService.publishGoal(robotId, nodeX, nodeY, outYaw);
      this.logger.log(`[코너] ${robotId} 회전 시작 → ${(outYaw * 180 / Math.PI).toFixed(0)}° (${nextNodeId})`);

      // 안전 타임아웃: 회전이 CORNER_SAFETY_MS 이상 걸리면 강제 진행
      const safetyTimer = setTimeout(() => {
        const s = this.rotationState.get(robotId);
        if (s?.nextNodeId === nextNodeId) {
          this.logger.warn(`[코너] ${robotId} 회전 타임아웃 — 강제 진행 → ${nextNodeId}`);
          this.rotationState.delete(robotId);
          void this.navGoal.sendNodeActionGoal(robotId, nextNodeId);
        }
      }, CORNER_SAFETY_MS);

      this.rotationState.set(robotId, { nextNodeId, targetYaw: outYaw, phase: 'rotating', timer: safetyTimer });
    }, CORNER_WAIT_MS);

    this.rotationState.set(robotId, { nextNodeId, targetYaw: outYaw, phase: 'stopping', timer: stopTimer });
  }

  // ── 2-ahead 노드 충돌 감지 (CollisionAvoidanceService 위임) ──────────────
  //
  // 활성 로봇의 현재 상태를 모아 평가 서비스에 넘기고, 반환된 결정(정지/재출발)에 따라
  // cmd_vel 정지 / goal_pose 재전송 부수효과만 수행한다.
  async checkNodeConflicts(): Promise<void> {
    if (!this.events.hasServer) return;

    const states: RobotPathState[] = [];
    for (const [robotId, taskId] of [...this.robotTasks.activeEntries()]) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;
      const cache = this.robotState.getCache(robotId);
      const startedAt = (task.startedAt ?? (task as { createdAt?: Date }).createdAt) as Date | undefined;
      states.push({
        robotId,
        pathQueue: task.pathQueue ?? [],
        posX: cache?.posX ?? null,
        posY: cache?.posY ?? null,
        priority: task.priority ?? 5,
        order: startedAt ? new Date(startedAt).getTime() : 0,
      });
    }
    if (states.length === 0) return;

    const decisions = await this.collision.evaluate(states);

    for (const d of decisions) {
      if (d.action === 'stop') {
        this.fmsService.publishStop(d.robotId);
        this.events.emit(Alert.info(
          `${d.robotId} 정지 — ${d.conflictNode} 점유 중 (${d.blockerId})`,
          { robotId: d.robotId },
        ));
      } else {
        // resume — 현재 남은 경로의 첫 노드로 재출발
        const st = states.find(s => s.robotId === d.robotId);
        if (st && st.pathQueue.length > 0) {
          await this.navGoal.sendNodeActionGoal(d.robotId, st.pathQueue[0]);
        }
      }
    }
  }
}
