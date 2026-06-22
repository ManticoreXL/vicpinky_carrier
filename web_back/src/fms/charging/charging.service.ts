import { Injectable, Logger } from '@nestjs/common';
import { RobotService } from '../../robot/robot.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { PathfindingService } from '../../pathfinding/pathfinding.service';
import { TopologyService } from '../../topology/topology.service';
import { GlobalTaskQueueService } from '../queue/global-task-queue.service';
import { TaskType } from '../task.schema';
import { NodeType, NodeDocument } from '../../topology/node.schema';

/** 충전소에 머무는 로봇 정보 (id + 배터리) */
export interface ChargerOccupant {
  chargerNodeId: string;
  robotId:       string;
  battery:       number | null; // 0~100 (%) — 없으면 null
}

/**
 * 자동충전 도메인 전담 서비스.
 *
 * 사람이 충전 목적지를 고르지 않는다 — 충전은 항상 백엔드가 알아서 결정한다.
 * 모든 노드/좌표 계산은 여기(백엔드)에서 수행하며, 프론트는 robotId만 보낸다.
 *
 * 충전소 점유는 노드 스키마의 isLockedBy 필드를 진실의 원천(source of truth)으로 삼는다:
 *   - 자동충전이 빈 충전소를 "목적지로 확정"하는 즉시 isLockedBy = robotId 예약 (도착 전에 선점)
 *   - 로봇이 새 태스크로 "출발"하면 releaseChargersHeldBy()로 해제 (이번 충전 목적지는 보존)
 *   - 자동충전 선택 시 isLockedBy가 채워진(=다른 로봇 점유/예약) 충전소는 후보에서 제외
 */
@Injectable()
export class ChargingService {
  private readonly logger = new Logger(ChargingService.name);

  constructor(
    private readonly robots:      RobotService,
    private readonly robotState:  RobotStateService,
    private readonly pathfinding: PathfindingService,
    private readonly topology:    TopologyService,
    private readonly queue:       GlobalTaskQueueService,
  ) {}

  // ── 점유 기록/해제 (isLockedBy) ──────────────────────────────────────────────

  /** 새 태스크 출발 → 이 로봇이 잡고 있던 충전소(들) 해제. keepNodeId(이번 충전 목적지)는 보존 */
  async releaseChargersHeldBy(robotId: string, keepNodeId?: string): Promise<void> {
    await this.topology.releaseChargersLockedBy(robotId, keepNodeId);
  }

  // ── 점유 현황 조회 ──────────────────────────────────────────────────────────

  /** 어느 충전소에 어떤 로봇이 있는지 — isLockedBy 기준. @returns Map<chargerNodeId, robotId> */
  async findChargerOccupants(mapId: string): Promise<Map<string, string>> {
    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    const occupied = new Map<string, string>();
    for (const c of chargers) if (c.isLockedBy) occupied.set(c.node_id, c.isLockedBy);
    return occupied;
  }

  /** 특정 로봇이 현재 점유한 충전소 노드 id (없으면 null) */
  async chargerOfRobot(robotId: string, mapId: string): Promise<string | null> {
    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    return chargers.find((c) => c.isLockedBy === robotId)?.node_id ?? null;
  }

  /**
   * ★ 충전소에 머무는 로봇의 id와 배터리를 불러온다.
   * 배터리는 실시간 캐시(batteryPct) 우선, 없으면 로봇 DB(battery) 폴백.
   */
  async getChargerOccupantsInfo(mapId: string): Promise<ChargerOccupant[]> {
    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    const result: ChargerOccupant[] = [];
    for (const c of chargers) {
      if (!c.isLockedBy) continue;
      result.push({
        chargerNodeId: c.node_id,
        robotId:       c.isLockedBy,
        battery:       await this.batteryOf(c.isLockedBy),
      });
    }
    return result;
  }

  /** 로봇 배터리(%) — 실시간 캐시 우선 → DB 폴백. 0~100 범위 밖 토픽값은 무시(null 취급). */
  private async batteryOf(robotId: string): Promise<number | null> {
    const cache = this.robotState.getCache(robotId);
    const fromCache = this.validBattery(cache?.batteryPct);
    if (fromCache != null) return fromCache;
    const robot = await this.robots.findById(robotId);
    return this.validBattery(robot?.battery);
  }

  /** 0~100 사이 값만 유효 배터리로 인정, 그 외(센서 오류 등)는 null */
  private validBattery(v: number | null | undefined): number | null {
    return v != null && v >= 0 && v <= 100 ? v : null;
  }

  // ── 자동충전 ────────────────────────────────────────────────────────────────
  //
  // 1) 로봇 현재 위치/맵 결정
  // 2) 이미 충전소를 점유 중이면 배차 생략
  // 3) isLockedBy가 비어 있는(미점유) 충전소 중 최근접 선택
  // 4) CHARGE 태스크를 우선순위 큐에 투입 (이후 배차/경로탐색/주행은 기존 파이프라인)
  async autoCharge(robotId: string): Promise<{ ok: boolean; message: string; targetNode?: string }> {
    const cache = this.robotState.getCache(robotId);
    const robot = await this.robots.findById(robotId);
    const x = cache?.posX ?? robot?.pose_x ?? null;
    const y = cache?.posY ?? robot?.pose_y ?? null;
    if (x == null || y == null) {
      return { ok: false, message: `${robotId} 현재 위치를 알 수 없어 충전소를 계산할 수 없습니다` };
    }

    const mapId = await this.resolveMapId(robot?.location ?? null, x, y);
    if (!mapId) {
      return { ok: false, message: `${robotId} 맵을 확인할 수 없습니다` };
    }

    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    if (chargers.length === 0) {
      return { ok: false, message: '등록된 충전소(CHARGER) 노드가 없습니다' };
    }

    // 이미 이 로봇이 점유한 충전소가 있으면 생략
    const mine = chargers.find((c) => c.isLockedBy === robotId);
    if (mine) {
      return { ok: true, message: `${robotId} 이미 충전소(${mine.node_id})에 있습니다 — 배차 생략`, targetNode: mine.node_id };
    }

    // 1) 비어 있는 충전소(isLockedBy 없음) 확인
    const free = chargers.filter((c) => !c.isLockedBy);

    let target: NodeDocument;
    let reason: string;
    if (free.length > 0) {
      // 2) 빈 충전소가 있으면 → 가장 가까운 빈 충전소로. 목적지 확정 즉시 isLockedBy=robotId 예약.
      target = this.nearest(free, x, y);
      await this.topology.setChargerLockedBy(target.node_id, robotId);
      reason = `최근접 빈 충전소 ${target.node_id} 예약(isLockedBy=${robotId})`;
    } else {
      // 3) 빈 충전소가 없으면 → 점유 로봇 중 배터리가 가장 많은 충전소로 (가장 먼저 비워질 가능성↑)
      const picked = await this.highestBatteryOccupied(chargers, x, y);
      if (!picked) return { ok: false, message: '향할 충전소를 결정할 수 없습니다' };
      target = picked.charger;
      reason = `빈 충전소 없음 — 점유 로봇 ${picked.occupantId}(배터리 ${picked.battery ?? '?'}%)의 충전소 ${target.node_id}로 이동`;
    }

    await this.queue.enqueue({
      type:             TaskType.CHARGE,
      targetNode:       target.node_id,
      preferredRobotId: robotId,
      priority:         1,
    });
    this.logger.log(`[자동충전] ${robotId} → ${reason}`);
    return { ok: true, message: `${robotId} → ${reason}`, targetNode: target.node_id };
  }

  // ── 선택 헬퍼 ──────────────────────────────────────────────────────────────

  /** 좌표 기준 최근접 노드 선택 */
  private nearest(nodes: NodeDocument[], x: number, y: number): NodeDocument {
    let best = nodes[0];
    let bestD = Math.hypot(best.x - x, best.y - y);
    for (const n of nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** 점유된 충전소 중 점유 로봇의 배터리가 가장 높은 충전소 (동률이면 더 가까운 쪽) */
  private async highestBatteryOccupied(
    chargers: NodeDocument[], x: number, y: number,
  ): Promise<{ charger: NodeDocument; occupantId: string; battery: number | null } | null> {
    const occupied = chargers.filter((c) => c.isLockedBy);
    if (occupied.length === 0) return null;
    const scored = await Promise.all(occupied.map(async (c) => ({
      charger:    c,
      occupantId: c.isLockedBy as string,
      battery:    await this.batteryOf(c.isLockedBy as string),
      dist:       Math.hypot(c.x - x, c.y - y),
    })));
    // 배터리 내림차순(null은 최하위), 동률이면 거리 오름차순
    scored.sort((a, b) => (b.battery ?? -1) - (a.battery ?? -1) || a.dist - b.dist);
    const top = scored[0];
    return { charger: top.charger, occupantId: top.occupantId, battery: top.battery };
  }

  // 맵 결정: location 노드의 map_id → 없으면 현재 좌표 최근접 노드의 map_id
  private async resolveMapId(location: string | null, x: number, y: number): Promise<string | undefined> {
    if (location) {
      const n = await this.topology.findNodeById(location);
      if (n?.map_id) return n.map_id;
    }
    const nearest = await this.pathfinding.findNearestNodeToPosition(x, y);
    if (nearest) return (await this.topology.findNodeById(nearest))?.map_id;
    return undefined;
  }
}
