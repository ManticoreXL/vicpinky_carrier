import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../../fms.service';
import { TaskStatus, TaskDocument } from '../../task.schema';
import { RobotService } from '../../../robot/robot.service';
import { RobotDocument, RobotStatus } from '../../../robot/robot.schema';
import { TaskManagerEventsService } from '../../../fms-events/task-manager-events.service';
import { Alert } from '../../../fms-events/alert';
import { TaskHandler } from './task-handler.interface';

/**
 * 공급(SUPPLY) — omx 로봇팔 전용. 내비게이션 없이 즉시 보급 수행.
 *
 * targetNode는 목적지 노드가 아니라 보급 품목(물/약)이다. omx는 고정형이라
 * 경로 탐색·이동 단계를 건너뛰고 바로 완료 처리한다. (실제 로봇팔 액션 연동 지점)
 */
@Injectable()
export class SupplyTaskHandler implements TaskHandler {
  private readonly logger = new Logger('SupplyTask');

  constructor(
    private readonly fmsService:   FmsService,
    private readonly robotService: RobotService,
    private readonly events:       TaskManagerEventsService,
  ) {}

  async handle(robot: RobotDocument, task: TaskDocument, taskId: string): Promise<boolean> {
    const robotId = robot.robot_id;
    await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.events.server, {
      assignedRobotId: robotId,
      startedAt:   new Date(),
      completedAt: new Date(),
    });
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
    this.events.emit(Alert.completed(taskId, robotId, `${robotId} 보급 완료 — ${task.targetNode}`));
    this.logger.log(`[보급] ${robotId} → ${task.targetNode} 공급 완료 (task: ${taskId})`);
    return false; // 즉시 완료 — 로봇은 계속 가용 상태
  }
}
