import { Injectable, Logger } from '@nestjs/common';
import { TaskType } from './task.schema';
import { RobotStatus, RobotDocument } from '../robot/robot.schema';
import { NodeType } from '../topology/node.schema';
import { RobotService } from '../robot/robot.service';
import { TopologyService } from '../topology/topology.service';
import { PathfindingService } from '../pathfinding/pathfinding.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from './global-task-queue.service';
import { ChargingService } from './charging.service';
import { NodeLockService } from './node-lock.service';
import { TaskPlannerService } from './task-planner.service';
import { RobotMonitorService } from './robot-monitor.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { CHARGE_TARGET_PCT } from '../fms-shared/task-manager.constants';

/**
 * 자동 충전 (on/off) — TaskManagerService에서 분리한 충전 재조정 로직.
 *
 * ON이면: 충전 필요(저배터리) 로봇을 빈 충전소(가까운 순)로 자동 이동. 빈 충전소 없으면 초기위치에서
 * 충전 대기(WAITING_CHARGE). 충전 끝난 로봇은 초기위치로 퇴거해 충전소를 비운다.
 * "충전소가 비는 순간"은 별도 이벤트 없이 매 주기 점유(DB lastNode/isLocked)로 감지한다.
 * TaskManagerService의 상태 틱이 매 주기 runIfEnabled()를 호출한다.
 */
@Injectable()
export class AutoChargerService {
  private readonly logger = new Logger(AutoChargerService.name);
  private autoCharge = false;

  constructor(
    private readonly robotService: RobotService,
    private readonly topology:     TopologyService,
    private readonly pathfinding:  PathfindingService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly globalQueue:  GlobalTaskQueueService,
    private readonly charging:     ChargingService,
    private readonly nodeLock:     NodeLockService,
    private readonly planner:      TaskPlannerService,
    private readonly monitor:      RobotMonitorService,
    private readonly events:       TaskManagerEventsService,
  ) {}

  setAutoCharge(on: boolean): void {
    this.autoCharge = on;
    this.logger.log(`[자동충전] ${on ? 'ON' : 'OFF'}`);
  }
  isAutoCharge(): boolean { return this.autoCharge; }

  /** 상태 틱에서 매 주기 호출 — ON일 때만 1회 충전 재조정 실행. */
  async runIfEnabled(): Promise<void> {
    if (this.autoCharge) await this.runAutoCharge();
  }

  private async runAutoCharge(): Promise<void> {
    if (!this.events.hasServer) return;
    const robots = await this.robotService.findAll();
    const mapIds = [...new Set(robots.map((r) => r.location).filter((m): m is string => !!m))];
    for (const mapId of mapIds) {
      await this.reconcileChargeForMap(mapId, robots.filter((r) => r.location === mapId));
    }
  }

  private async reconcileChargeForMap(mapId: string, mapRobots: RobotDocument[]): Promise<void> {
    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    if (chargers.length === 0) return;
    const initNode = await this.topology.findInitPositionNode(mapId);

    // 1) 충전 완료 로봇 퇴거 → 초기위치(충전소 비우기). 점유는 DB(robot.lastNode) 기준.
    for (const c of chargers) {
      const r = mapRobots.find((x) => x.lastNode === c.node_id); // 그 충전소 노드에 있는 로봇(DB)
      if (!r || !initNode) continue;
      const bat = this.robotState.getCache(r.robot_id)?.batteryPct ?? r.battery ?? null;
      // 충전 완료(80%↑) + 작업 없음 → 충전소 잠금 해제 + 초기위치로 퇴거(A* MOVE). 도착하면 대기중(IDLE).
      if (bat != null && bat >= CHARGE_TARGET_PCT && !this.robotTasks.hasActive(r.robot_id) &&
          (r.status === RobotStatus.CHARGING || r.status === RobotStatus.IDLE)) {
        await this.nodeLock.lockNode(c.node_id, false);  // DB 잠금 해제(이 로봇이 떠나면 빈 충전소가 됨)
        await this.autoCreateAndDispatch(r.robot_id, TaskType.MOVE, initNode.node_id);
        this.logger.log(`[자동충전] ${r.robot_id} 충전 완료(${Math.round(bat)}%) → 초기위치 퇴거(대기중)`);
      }
    }

    // 2) 빈 충전소 — DB 기반(잠김 isLocked + 로봇 위치 lastNode). 둘 다 아니면 빔.
    let free = await this.charging.getFreeChargers(mapId);

    // 3) 충전 필요 로봇 — 하던 작업이 있으면 끝낼 때까지 기다린다(선점 안 함). 즉 작업 중(hasActive)·충전/복귀/오류/정지 중은 제외.
    //    배터리 낮은 순. (작업 끝나 IDLE이 되면 다음 틱에 자동으로 충전 이동)
    const blocked = [RobotStatus.TO_CHARGE, RobotStatus.CHARGING, RobotStatus.RETURNING, RobotStatus.ERROR, RobotStatus.PAUSED, RobotStatus.OFFLINE];
    const needy = mapRobots
      .filter((r) =>
        this.monitor.needsCharge(r.robot_id) && r.online && this.isDrivable(r.robot_id) &&
        !blocked.includes(r.status) && !this.robotTasks.hasActive(r.robot_id))
      .sort((a, b) => (this.robotState.getCache(a.robot_id)?.batteryPct ?? 100) - (this.robotState.getCache(b.robot_id)?.batteryPct ?? 100));

    for (const robot of needy) {
      if (free.length > 0) {
        const nearest = await this.nearestCharger(robot.robot_id, free);
        if (!nearest) continue;
        await this.autoCreateAndDispatch(robot.robot_id, TaskType.CHARGE, nearest.node_id, 8); // 충전은 낮은 우선권(이동·구호 아래)
        this.logger.log(`[자동충전] ${robot.robot_id} → 충전소 ${nearest.node_id} 자동 이동`);
        free = free.filter((c) => c.node_id !== nearest.node_id); // 이번 틱 예약
      } else {
        await this.sendToWaitCharge(robot, initNode);             // 빈 충전소 없음 → 초기위치 대기
      }
    }
  }

  // omx(팔)·vicpinky(캐리어)는 충전소로 이동 불가 → 자동 충전 대상 제외(터틀봇/테스트봇만)
  private isDrivable(robotId: string): boolean {
    return !robotId.startsWith('omx') && !robotId.startsWith('vicpinky');
  }

  private async nearestCharger(robotId: string, chargers: Array<{ node_id: string }>): Promise<{ node_id: string } | null> {
    const cache = this.robotState.getCache(robotId);
    if (cache?.posX == null || cache.posY == null) return chargers[0] ?? null;
    let best: { node_id: string } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of chargers) {
      const d = await this.pathfinding.hopDistanceFromPosition(cache.posX, cache.posY, c.node_id);
      if (d != null && d < bestDist) { bestDist = d; best = c; }
    }
    return best ?? chargers[0] ?? null;
  }

  private async sendToWaitCharge(robot: RobotDocument, initNode: { node_id: string } | null): Promise<void> {
    if (!initNode || robot.status === RobotStatus.WAITING_CHARGE) return; // 이미 대기 중이면 그대로
    if (robot.lastNode === initNode.node_id) {
      // 이미 초기위치 도착 → 충전 대기 상태로 표시(여기 머무름)
      await this.robotService.updateStatus(robot.robot_id, RobotStatus.WAITING_CHARGE);
      this.events.broadcast('robot_status_changed', { robot_id: robot.robot_id, status: RobotStatus.WAITING_CHARGE });
      this.events.emit(Alert.info(`${robot.robot_id} 충전소 만석 — 초기위치에서 충전 대기`, { robotId: robot.robot_id }));
      this.logger.log(`[자동충전] ${robot.robot_id} 충전 대기(WAITING_CHARGE)`);
      return;
    }
    // 초기위치로 이동 — MOVE 태스크(handleNav → A* pathfinding, 노드-노드 경유). 도착 후 다음 틱에 대기 전환.
    await this.autoCreateAndDispatch(robot.robot_id, TaskType.MOVE, initNode.node_id);
    this.logger.log(`[자동충전] ${robot.robot_id} 충전소 만석 → 초기위치로 이동(대기 예정)`);
  }

  // 충전/퇴거용 태스크 생성 + 즉시 디스패치 (CHARGE=충전소로 / MOVE=초기위치로)
  // priority 숫자(1=긴급…10=낮음)는 표시용. 충전은 이동/구호보다 낮은 우선권이라 높은 숫자(=낮음)로.
  private async autoCreateAndDispatch(robotId: string, type: TaskType, targetNode: string, priority = 5): Promise<void> {
    const task = await this.globalQueue.enqueue({ type, targetNode, preferredRobotId: robotId, priority });
    await this.planner.planTask(String((task as { _id: unknown })._id));
  }
}
