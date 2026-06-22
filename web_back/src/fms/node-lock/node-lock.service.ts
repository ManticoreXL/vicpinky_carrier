import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TaskStatus } from '../task.schema';
import { RobotService } from '../../robot/robot.service';
import { TopologyService } from '../../topology/topology.service';
import { PathfindingService } from '../../pathfinding/pathfinding.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../fms-state/robot-task-queue.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { NavGoalService } from '../navigation/nav-goal.service';

/**
 * 노드 잠금·해제 + 실시간 우회 재경로.
 *
 * 노드를 잠그면(장애/관제 차단) 그 노드를 경유 중인 모든 활성 로봇의 경로를
 * 재계산해 우회시킨다. DB 잠금 + 소켓 브로드캐스트는 TopologyService.setNodeLocked()가
 * 수행하고, 이 서비스는 잠금 이후의 재경로만 책임진다.
 */
@Injectable()
export class NodeLockService {
  private readonly logger = new Logger(NodeLockService.name);

  constructor(
    private readonly fmsService:    FmsService,
    private readonly robotService:  RobotService,
    private readonly topology:      TopologyService,
    private readonly pathfinding:   PathfindingService,
    private readonly robotState:    RobotStateService,
    private readonly robotTasks:    RobotTaskQueueService,
    private readonly events:        TaskManagerEventsService,
    private readonly navGoal:       NavGoalService,
  ) {}

  /** 현재 잠긴 노드 ID 목록 */
  getLockedNodeIds(): Promise<string[]> {
    return this.topology.getAllLockedNodeIds();
  }

  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    await this.topology.setNodeLocked(nodeId, isLocked);
    if (!this.events.hasServer || !isLocked) return; // 잠금 해제 시 재경로 불필요

    for (const [robotId, taskId] of this.robotTasks.activeEntries()) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;

      const pathQueue = task.pathQueue ?? [];
      if (!pathQueue.includes(nodeId)) continue; // 이 노드 미포함

      this.logger.log(`[노드 폐쇄] ${robotId} 재경로 (차단 노드: ${nodeId})`);

      const cache      = this.robotState.getCache(robotId);
      const robot      = await this.robotService.findById(robotId);
      const targetNode = await this.topology.findNodeById(task.targetNode);
      if (!targetNode) continue;

      let startId: string | null = robot?.location ?? null;
      if (!startId && cache?.posX != null && cache.posY != null) {
        startId = await this.pathfinding.findNearestNodeToPosition(
          cache.posX, cache.posY, targetNode.map_id,
        );
      }
      if (!startId || startId === task.targetNode) continue;

      // 우회 재경로도 점유는 무시하고 잠금 노드만 회피 (점유는 주행 단계에서 양보 처리)
      const newRaw = await this.pathfinding.findPath(startId, task.targetNode, targetNode.map_id);

      if (newRaw.length === 0) {
        this.logger.warn(`[노드 폐쇄] ${robotId}: 우회 경로 없음 — 정지 대기`);
        await this.fmsService.setWaitReason(taskId, `노드 ${nodeId} 폐쇄로 우회 경로 없음`);
        this.fmsService.publishStop(robotId);
        continue;
      }

      const newQueue = newRaw.slice(1); // startId는 현재 위치이므로 제외
      await this.fmsService.updatePathQueue(taskId, newQueue, this.events.server!, newQueue);
      await this.navGoal.sendNodeActionGoal(robotId, newQueue[0]);

      this.logger.log(`[재경로] ${robotId}: ${newQueue.join(',')} (우회)`);
      this.events.emit(Alert.info(`${robotId} 노드 ${nodeId} 우회 재경로`, { taskId, robotId }));
    }
  }
}
