import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../../fms.service';
import { TaskStatus, TaskDocument } from '../../task.schema';
import { RobotService } from '../../../robot/robot.service';
import { RobotDocument, RobotStatus } from '../../../robot/robot.schema';
import { TopologyService } from '../../../topology/topology.service';
import { PathfindingService } from '../../../pathfinding/pathfinding.service';
import { RobotStateService } from '../../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../../fms-state/robot-task-queue.service';
import { TaskManagerEventsService } from '../../../fms-events/task-manager-events.service';
import { Alert } from '../../../fms-events/alert';
import { NavGoalService } from '../../navigation/nav-goal.service';
import { NodeLockService } from '../../node-lock/node-lock.service';
import { TaskHandler } from './task-handler.interface';

/**
 * 주행 태스크(MOVE/PROCESS/CHARGE) — 경로 탐색 후 노드 단위로 주행.
 *
 * 1) resolvePath(): 출발 노드 결정(robot.location → AMCL 최근접) + A* 경로 탐색
 * 2) 활성 태스크 등록 + DB ASSIGNED + 로봇 MOVING + 목적지 노드 잠금
 * 3) 첫 노드로 goal_pose 전송 (이후 도착 감지는 NavigationService가 담당)
 */
@Injectable()
export class NavigationTaskHandler implements TaskHandler {
  private readonly logger = new Logger('NavigationTask');

  constructor(
    private readonly fmsService:   FmsService,
    private readonly robotService: RobotService,
    private readonly topology:     TopologyService,
    private readonly pathfinding:  PathfindingService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly events:       TaskManagerEventsService,
    private readonly navGoal:      NavGoalService,
    private readonly nodeLock:     NodeLockService,
  ) {}

  async handle(robot: RobotDocument, task: TaskDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;

    this.logger.log(
      `[dispatch] ${robotId} 태스크 ${taskId} 배정 시작` +
      ` | location=${robot.location ?? 'null'}` +
      ` | target=${task.targetNode}`,
    );

    // ── 경로 탐색 (실패 시 null — waitReason/FAILED 처리는 내부에서 수행) ──
    const pathQueue = await this.resolvePath(robot, task, taskId);
    if (pathQueue === null) return false;

    this.robotTasks.setActive(robotId, taskId);

    await this.fmsService.assignToRobot(taskId, robotId, pathQueue, this.events.server!);
    await this.robotService.updateStatus(robotId, RobotStatus.MOVING);
    await this.nodeLock.lockNode(task.targetNode, true);

    const firstGoalId = pathQueue[0] ?? task.targetNode;
    await this.navGoal.sendNodeActionGoal(robotId, firstGoalId);

    this.events.emit(Alert.assigned(taskId, robotId,
      `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당 — 경로: [${pathQueue.join('→')}]`));
    return true;
  }

  // ── 경로 해석 ─────────────────────────────────────────────────────────────
  //
  // 출발 노드 우선순위: robot.location(현재 맵의 유효 노드) → AMCL 최근접 노드.
  // 목적지 노드 없음 / 경로 없음이면 waitReason·FAILED 처리 후 null 반환(=스킵).
  private async resolvePath(
    robot: RobotDocument,
    task: TaskDocument,
    taskId: string,
  ): Promise<string[] | null> {
    const robotId = robot.robot_id;
    let pathQueue: string[] = [];

    // 목적지 노드 확인 (map_id 결정에 필요)
    const targetNode = await this.topology.findNodeById(task.targetNode);
    if (!targetNode) {
      this.logger.warn(`[dispatch] 목적지 노드 "${task.targetNode}"가 DB에 없음`);
      await this.fmsService.setWaitReason(taskId, `목적지 노드 없음: ${task.targetNode}`);
      await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.events.server!);
      return null;
    }
    const myMapId = targetNode.map_id;

    // 출발 노드 결정: robot.location이 현재 맵의 실제 노드인지 검증
    let startNodeId: string | null = null;
    let startFromLocation = false;

    if (robot.location && robot.location !== task.targetNode) {
      const locNode = await this.topology.findNodeById(robot.location);
      if (locNode && locNode.map_id === myMapId) {
        startNodeId = robot.location;
        startFromLocation = true;
      }
    }

    // AMCL 캐시로 최근접 노드 탐색 (robot.location 무효 또는 null인 경우)
    const getAmclNode = async (): Promise<string | null> => {
      const cache2 = this.robotState.getCache(robotId);
      if (cache2?.posX != null && cache2.posY != null) {
        return this.pathfinding.findNearestNodeToPosition(cache2.posX, cache2.posY, myMapId);
      }
      return null;
    };

    if (!startNodeId) {
      const amclNode = await getAmclNode();
      if (amclNode) {
        startNodeId = amclNode;
        await this.robotService.updateLocation(robotId, amclNode);
      }
    }

    // 출발 노드가 없거나 이미 목적지라면 목적지 직행
    if (!startNodeId || startNodeId === task.targetNode) {
      this.logger.log(`[dispatch] ${robotId} startNode=${startNodeId ?? 'null'} — 목적지 직행 [${task.targetNode}]`);
      pathQueue = [task.targetNode];
    } else {
      // 경로 계획은 점유(다른 로봇)는 무시하고 잠금(장애) 노드만 회피한다.
      // 점유 충돌은 주행 단계에서 우선순위 양보(CollisionAvoidanceService)로 처리.
      let rawPath = await this.pathfinding.findPath(startNodeId, task.targetNode, myMapId);

      // location 노드로 경로 탐색 실패 시 AMCL 위치 기반으로 재시도
      if (rawPath.length === 0 && startFromLocation) {
        this.logger.warn(`[dispatch] location 노드 "${startNodeId}" 경로 없음 (엣지 없음?) — AMCL 위치 기반 재탐색`);
        const amclNode = await getAmclNode();
        if (amclNode && amclNode !== startNodeId) {
          const retryPath = await this.pathfinding.findPath(amclNode, task.targetNode, myMapId);
          if (retryPath.length > 0) {
            this.logger.log(`[dispatch] AMCL 재탐색 성공: ${amclNode} → ${task.targetNode}`);
            startNodeId = amclNode;
            rawPath = retryPath;
            await this.robotService.updateLocation(robotId, amclNode);
          }
        }
      }

      if (rawPath.length === 0) {
        this.logger.warn(`[dispatch] 경로 없음: ${startNodeId} → ${task.targetNode} (${robotId})`);
        await this.fmsService.setWaitReason(taskId, `경로 없음: ${startNodeId} → ${task.targetNode}`);
        // 노드 폐쇄 등으로 수행 불가 → 수동제어 전환을 유도하는 알림 (requiresAction)
        this.events.emit(Alert.noPath(taskId, robotId, `경로를 찾을 수 없음: ${startNodeId} → ${task.targetNode} — 수동제어가 필요합니다`));
        await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.events.server!);
        return null;
      }
      pathQueue = rawPath.slice(1);
      const nodeTypes = await Promise.all(
        rawPath.map(id => this.topology.findNodeById(id).then(n => n ? `${id}(${n.type})` : `${id}(?)`)),
      );
      this.logger.log(`[dispatch] ${robotId} 경로 확정: [${nodeTypes.join('→')}] queue=[${pathQueue.join('→')}]`);
    }

    return pathQueue;
  }
}
