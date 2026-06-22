import { Injectable, Logger } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TopologyService } from '../../topology/topology.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';

/**
 * 로봇에게 보내는 저수준 주행 명령(goal_pose / cmd_vel 정지 / 홈 복귀)을 모은 leaf 서비스.
 *
 * NodeLockService·DispatchService·NavigationService가 모두 "다음 노드로 가라"를
 * 호출해야 하는데, 이 기능을 leaf로 빼두면 그 상위 서비스끼리 서로 의존할 필요가
 * 없어져 순환 의존을 피한다.
 */
@Injectable()
export class NavGoalService {
  private readonly logger = new Logger('NavGoal');

  // 동시 amcl_pose 이벤트로 인한 중복 goal 방지
  private readonly lastSentGoal = new Map<string, { nodeId: string; ts: number }>();

  constructor(
    private readonly fmsService:    FmsService,
    private readonly topology:      TopologyService,
    private readonly robotState:    RobotStateService,
    private readonly events:        TaskManagerEventsService,
  ) {}

  // ── 노드 단위 goal_pose 토픽 전송 ──────────────────────────────────────
  // domain_bridge: /{robotId}/goal_pose (domain40) → /goal_pose (robot domain)
  // 도착 감지: NavigationService.checkWaypointArrival (amcl_pose 위치 기반)
  async sendNodeActionGoal(robotId: string, nodeId: string): Promise<void> {
    const last = this.lastSentGoal.get(robotId);
    if (last?.nodeId === nodeId && Date.now() - last.ts < 300) {
      this.logger.debug(`[sendNodeGoal] ${robotId} → ${nodeId} 중복 스킵 (${Date.now() - last.ts}ms)`);
      return;
    }
    this.lastSentGoal.set(robotId, { nodeId, ts: Date.now() });

    const node = await this.topology.findNodeById(nodeId);
    if (!node) {
      this.logger.warn(`[sendNodeGoal] 노드 "${nodeId}" DB에 없음`);
      return;
    }

    const yaw = node.yaw ?? 0;
    this.fmsService.publishGoal(robotId, node.x, node.y, yaw);
    this.logger.log(`[goal_pose] ${robotId} → ${nodeId} (${node.x.toFixed(2)}, ${node.y.toFixed(2)}) yaw=${(yaw * 180 / Math.PI).toFixed(0)}°`);
  }

  /** cmd_vel=0 정지를 3회 연속 발행 (nav2가 반응하기 전 확실한 정지 보장) */
  hardStop(robotId: string): void {
    for (let i = 0; i < 3; i++) this.fmsService.publishStop(robotId);
  }

  /** 등록된 홈 위치로 복귀 (홈 미등록 시 무시) */
  returnHome(robotId: string): void {
    const home = this.robotState.getHome(robotId);
    if (!home) return;
    this.fmsService.publishGoal(robotId, home.x, home.y, home.yaw);
    this.events.emit(Alert.info(`${robotId} 홈 복귀 중`, { robotId }));
  }
}
