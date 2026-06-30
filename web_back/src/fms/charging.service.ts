import { Injectable } from '@nestjs/common';
import { RobotService } from '../robot/robot.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { TopologyService } from '../topology/topology.service';
import { NodeType, NodeDocument } from '../topology/node.schema';
import { validBatteryPct } from '../common/battery';

/** 충전소에 머무는 로봇 정보 (id + 배터리 + 실제 충전 여부) */
export interface ChargerOccupant {
  chargerNodeId: string;
  robotId:       string;
  battery:       number | null;  // 0~100(%) — 없으면 null
  charging:      boolean | null; // battery_state 기준. null = 미보고
}

/**
 * 충전소 점유 현황 조회 (모니터링 전용).
 *
 * 수동 충전 모델: 사용자가 로봇을 충전소 노드로 직접 보낸다(일반 CHARGE 태스크 → 도착 시 CHARGING).
 * 자동 최근접 선택·원자 예약·만석 자동대기·곧빌충전소 큐등록은 모두 제거됨. 어느 충전소에 어떤
 * 로봇이 있는지는 NodeOccupancyService(도달 노드 점유)를 진실의 원천으로 삼아 조회만 제공한다.
 */
@Injectable()
export class ChargingService {
  constructor(
    private readonly robots:     RobotService,
    private readonly robotState: RobotStateService,
    private readonly topology:   TopologyService,
  ) {}

  /**
   * 빈 충전소 — DB 기반 점유 판정. 두 가지를 합쳐서 본다(둘 다 DB라 재시작에도 유지):
   *   1) 노드 잠김(isLocked) — 충전 배차 시 handleNav가 거는 노드 락(예약/이동 중) + 충전 중 유지
   *   2) 로봇 위치(robot.lastNode) — 그 충전소 노드에 실제로 있는 로봇
   * 둘 다 아니면 "빈 충전소".
   */
  async getFreeChargers(mapId: string): Promise<NodeDocument[]> {
    const chargers = await this.topology.findNodesByType(mapId, NodeType.CHARGER);
    if (chargers.length === 0) return [];
    const locked = new Set(await this.topology.getAllLockedNodeIds());                       // DB: 잠김
    const occupied = new Set(
      (await this.robots.findByMap(mapId)).map((r) => r.lastNode).filter((n): n is string => !!n), // DB: 로봇 위치
    );
    return chargers.filter((c) => !locked.has(c.node_id) && !occupied.has(c.node_id));
  }

  /** 특정 충전소 노드를 점유한 로봇(DB lastNode 기준) — 없으면 null */
  async occupantOf(mapId: string, chargerNodeId: string): Promise<{ robot_id: string; status: string; battery: number | null } | null> {
    const robots = await this.robots.findByMap(mapId);
    const r = robots.find((x) => x.lastNode === chargerNodeId);
    return r ? { robot_id: r.robot_id, status: r.status, battery: await this.batteryOf(r.robot_id) } : null;
  }

  /** 충전소에 머무는 로봇의 id·배터리·충전여부 목록. 점유 판정은 DB(robot.lastNode === 충전소 노드). */
  async getChargerOccupantsInfo(mapId: string): Promise<ChargerOccupant[]> {
    const chargerIds = new Set((await this.topology.findNodesByType(mapId, NodeType.CHARGER)).map((c) => c.node_id));
    const result: ChargerOccupant[] = [];
    for (const r of await this.robots.findByMap(mapId)) {
      if (!r.lastNode || !chargerIds.has(r.lastNode)) continue; // DB: 그 충전소 노드에 있는 로봇만
      result.push({
        chargerNodeId: r.lastNode,
        robotId:  r.robot_id,
        battery:  await this.batteryOf(r.robot_id),
        charging: this.robotState.getCache(r.robot_id)?.charging ?? null, // 충전여부는 실시간 텔레메트리
      });
    }
    return result;
  }

  /** 로봇 배터리(%) — 실시간 캐시 우선 → DB 폴백. 0~100 밖 값은 무시(null). */
  private async batteryOf(robotId: string): Promise<number | null> {
    const fromCache = validBatteryPct(this.robotState.getCache(robotId)?.batteryPct);
    if (fromCache != null) return fromCache;
    const robot = await this.robots.findById(robotId);
    return validBatteryPct(robot?.battery);
  }
}
