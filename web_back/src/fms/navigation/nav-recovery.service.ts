import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TaskStatus } from '../task.schema';
import { TopologyService } from '../../topology/topology.service';
import { CollisionAvoidanceService } from '../../collision-avoidance/collision-avoidance.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../fms-state/robot-task-queue.service';
import { RotationStateService } from '../../fms-state/rotation-state.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { NavGoalService } from './nav-goal.service';
import { AMCL_TIMEOUT_MS } from '../../fms-shared/task-manager.constants';

/**
 * Nav2 / AMCL 복구.
 *
 * amcl_pose가 AMCL_TIMEOUT_MS(60s) 이상 끊기면 nav2 TF 초기화 중으로 보고 태스크를
 * SUSPENDED 로 보류(activeTasks에서만 제거, FAILED 아님). AMCL이 복구되면 goal_pose를
 * 재전송하고 태스크를 RUNNING 으로 자동 재개한다.
 */
@Injectable()
export class NavRecoveryService {
  private readonly logger = new Logger(NavRecoveryService.name);

  // AMCL 타임아웃으로 일시정지된 태스크 (복구 시 자동 재개)
  private readonly suspendedTasks = new Map<string, string>();

  constructor(
    private readonly fmsService:    FmsService,
    private readonly topology:      TopologyService,
    private readonly collision:     CollisionAvoidanceService,
    private readonly robotState:    RobotStateService,
    private readonly robotTasks:    RobotTaskQueueService,
    private readonly rotationState: RotationStateService,
    private readonly events:        TaskManagerEventsService,
    private readonly navGoal:       NavGoalService,
  ) {}

  // ── AMCL 타임아웃 감지 → SUSPENDED 보류 ──────────────────────────────────
  async checkAmclTimeout(): Promise<void> {
    if (!this.events.hasServer) return;
    const now = Date.now();

    for (const [robotId, taskId] of [...this.robotTasks.activeEntries()]) {
      const cache = this.robotState.getCache(robotId);
      if (!cache || cache.lastAmclMs == null) continue;
      if (now - cache.lastAmclMs < AMCL_TIMEOUT_MS) continue;
      if (cache.amclSuspended) continue; // 이미 처리됨

      this.logger.warn(`[AMCL타임아웃] ${robotId} — ${AMCL_TIMEOUT_MS / 1000}s간 amcl_pose 없음 → nav2 초기화 추정, 태스크 일시정지`);

      this.robotTasks.clearActive(robotId);
      this.rotationState.clear(robotId);
      this.collision.clear(robotId);

      // 태스크는 SUSPENDED (FAILED 아님) — 복구 후 재개 가능
      const task = await this.fmsService.getTask(taskId);
      if (task && task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.FAILED) {
        await this.fmsService.setWaitReason(taskId, 'Nav2 초기화 중 — AMCL 복구 대기');
        await this.fmsService.setStatus(taskId, TaskStatus.SUSPENDED, this.events.server);
      }

      this.robotState.patchCache(robotId, { amclSuspended: true });
      this.suspendedTasks.set(robotId, taskId);

      this.events.emit(Alert.info(`${robotId} Nav2 초기화 감지 — AMCL 복구 시 자동 재개`, { taskId, robotId }));
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    }
  }

  // ── AMCL 복구 감지 → 일시정지 태스크 자동 재개 ────────────────────────────
  async checkResume(robotId: string, x: number, y: number, yaw: number): Promise<void> {
    const cache = this.robotState.getCache(robotId);
    if (!cache?.amclSuspended) return;

    const taskId = this.suspendedTasks.get(robotId);
    if (!taskId) { this.robotState.patchCache(robotId, { amclSuspended: false }); return; }

    const task = await this.fmsService.getTask(taskId);
    if (!task || task.status !== TaskStatus.SUSPENDED) {
      this.suspendedTasks.delete(robotId);
      this.robotState.patchCache(robotId, { amclSuspended: false });
      return;
    }

    this.logger.log(`[AMCL복구] ${robotId} — AMCL 재수신, 태스크 ${taskId} 재개`);

    // 초기 위치 재설정 (AMCL 안정화 지원)
    this.fmsService.publishInitialPose(robotId, x, y, yaw);

    // 잠깐 대기 후 goal_pose 재전송
    await new Promise(r => setTimeout(r, 2000));

    const freshTask = await this.fmsService.getTask(taskId);
    if (!freshTask || freshTask.status !== TaskStatus.SUSPENDED) return;

    const nextNodeId = (freshTask.pathQueue ?? [])[0] ?? freshTask.targetNode;
    const nextNode   = await this.topology.findNodeById(nextNodeId);
    if (!nextNode) {
      this.logger.warn(`[AMCL복구] ${robotId} 다음 노드 "${nextNodeId}" 없음 — FAILED`);
      await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
      this.suspendedTasks.delete(robotId);
      this.robotState.patchCache(robotId, { amclSuspended: false });
      return;
    }

    // 태스크 RUNNING 복귀 + activeTasks 재등록
    await this.fmsService.setStatus(taskId, TaskStatus.RUNNING, this.events.server);
    this.robotTasks.setActive(robotId, taskId);
    this.suspendedTasks.delete(robotId);
    this.robotState.patchCache(robotId, { amclSuspended: false });

    await this.navGoal.sendNodeActionGoal(robotId, nextNodeId);
    this.events.emit(Alert.info(`${robotId} AMCL 복구 — 태스크 재개: ${nextNodeId}`, { taskId, robotId }));
  }
}
