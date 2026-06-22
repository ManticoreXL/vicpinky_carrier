import { Injectable, Logger } from '@nestjs/common';
import { RobotService } from '../../robot/robot.service';
import { RobotStatus } from '../../robot/robot.schema';
import { PathfindingService } from '../../pathfinding/pathfinding.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { NodeLockService } from '../node-lock/node-lock.service';
import { FALL_THRESH_RAD } from '../../fms-shared/task-manager.constants';
import { Quaternion } from '../../geometry/pose';

/**
 * IMU 기반 전복 감지 + 자세 복귀.
 *
 * roll/pitch가 FALL_THRESH_RAD(45°)를 넘으면 전복으로 판정:
 *   - 로봇 상태 ERROR 전환 + 브로드캐스트
 *   - AMCL 최근접 노드를 "장애"로 잠금(전복 지점 봉쇄 → 경유 로봇 자동 우회)
 * 자세가 정상 복귀하면 ERROR→IDLE 되돌리고 잠갔던 노드를 해제한다.
 */
@Injectable()
export class FallDetectionService {
  private readonly logger = new Logger(FallDetectionService.name);

  // 전복 알림 중복 방지 (30s 쿨다운)
  private readonly lastFallAlert   = new Map<string, number>();
  // robotId → 전복으로 장애 잠금한 노드 ID (자세 복귀 시 자동 해제용)
  private readonly fallLockedNodes = new Map<string, string>();

  constructor(
    private readonly robotService: RobotService,
    private readonly pathfinding:  PathfindingService,
    private readonly robotState:   RobotStateService,
    private readonly events:       TaskManagerEventsService,
    private readonly nodeLock:     NodeLockService,
  ) {}

  onImu(robotId: string, ori: { x?: number; y?: number; z?: number; w?: number }): void {
    const now = Date.now();
    const q = Quaternion.from(ori);
    const roll = q.roll, pitch = q.pitch;

    if (Math.abs(roll) > FALL_THRESH_RAD || Math.abs(pitch) > FALL_THRESH_RAD) {
      const last = this.lastFallAlert.get(robotId) ?? 0;
      if (now - last <= 30_000) return;
      this.lastFallAlert.set(robotId, now);

      // 상태 ERROR 전환 + DB 저장 + 프론트 브로드캐스트
      void this.robotService.updateStatus(robotId, RobotStatus.ERROR);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.ERROR });

      // AMCL 위치 기준 최근접 노드를 "장애"로 잠금 (전복 지점 봉쇄 + 경유 로봇 자동 우회)
      const cache = this.robotState.getCache(robotId);
      if (cache?.posX != null && cache.posY != null) {
        const px = cache.posX, py = cache.posY;
        void (async () => {
          const nearestNodeId = await this.pathfinding.findNearestNodeToPosition(px, py);
          if (!nearestNodeId) return;
          this.fallLockedNodes.set(robotId, nearestNodeId);
          await this.nodeLock.lockNode(nearestNodeId, true);
          this.logger.warn(`[전복-장애] ${robotId} 전복 지점 노드 ${nearestNodeId} → 장애 인식, 잠금`);
        })();
      }

      this.events.emit(Alert.fall(robotId,
        `${robotId} 전복 감지 — roll ${(roll * 180 / Math.PI).toFixed(0)}° / pitch ${(pitch * 180 / Math.PI).toFixed(0)}° → 상태 ERROR, 전복 지점 노드 장애 잠금`));
      return;
    }

    // 자세 정상 복귀 시 로봇 상태(ERROR→IDLE) + 전복 지점 장애 노드 자동 해제
    void this.robotService.findById(robotId).then((robot) => {
      if (robot?.status !== RobotStatus.ERROR) return;
      void this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
      this.lastFallAlert.delete(robotId);
      const lockedNodeId = this.fallLockedNodes.get(robotId);
      if (lockedNodeId) {
        this.fallLockedNodes.delete(robotId);
        void this.nodeLock.lockNode(lockedNodeId, false);
        this.logger.log(`[전복복구] ${robotId} 자세 복귀 → 노드 ${lockedNodeId} 장애 잠금 해제`);
      }
    });
  }
}
