import { ChargingService } from './charging.service';

// 충전소 점유 조회 단위 테스트 — DB(robot.lastNode === 충전소 노드)를 진실의 원천으로.
function makeCharging(cfg: {
  chargers?: any[];
  occupant?: Record<string, string>;   // chargerNodeId → robotId (점유 = 그 충전소에 lastNode 위치)
  battery?: Record<string, number>;    // robotId → 배터리(캐시)
  charging?: Record<string, boolean>;  // robotId → 충전여부(캐시)
} = {}) {
  // 점유 로봇 = lastNode 가 충전소 노드인 로봇 (DB findByMap)
  const robotsList = Object.entries(cfg.occupant ?? {}).map(([node, rid]) => ({ robot_id: rid, lastNode: node, battery: null as number | null }));
  const robots = {
    findByMap: jest.fn(async () => robotsList),
    findById:  jest.fn(async (id: string) => ({ robot_id: id, battery: null })),
  };
  const robotState = {
    getCache: jest.fn((id: string) => {
      const b = cfg.battery?.[id]; const c = cfg.charging?.[id];
      if (b == null && c == null) return undefined;
      return { batteryPct: b ?? null, charging: c ?? null };
    }),
  };
  const topology = { findNodesByType: jest.fn(async () => cfg.chargers ?? []) };
  const svc = new ChargingService(robots as any, robotState as any, topology as any);
  return { svc, robots, robotState, topology };
}

const charger = (node_id: string) => ({ node_id, type: 'CHARGER', map_id: 'm1' });

describe('ChargingService.getChargerOccupantsInfo — 충전소 점유 조회(모니터링, DB lastNode)', () => {
  it('점유 로봇이 없으면 빈 배열', async () => {
    const { svc } = makeCharging({ chargers: [charger('C1'), charger('C2')] });
    expect(await svc.getChargerOccupantsInfo('m1')).toEqual([]);
  });

  it('충전소 노드에 lastNode가 있는 로봇을 id·배터리·충전여부와 함께 반환', async () => {
    const { svc } = makeCharging({
      chargers: [charger('C1'), charger('C2')],
      occupant: { C1: 'R1' }, battery: { R1: 77 }, charging: { R1: true },
    });
    expect(await svc.getChargerOccupantsInfo('m1')).toEqual([
      { chargerNodeId: 'C1', robotId: 'R1', battery: 77, charging: true },
    ]);
  });

  it('캐시 배터리 없으면 로봇 DB 배터리로 폴백', async () => {
    const { svc, robots } = makeCharging({ chargers: [charger('C1')], occupant: { C1: 'R1' } });
    robots.findById.mockResolvedValue({ robot_id: 'R1', battery: 42 } as any);
    const occ = await svc.getChargerOccupantsInfo('m1');
    expect(occ[0].battery).toBe(42);
    expect(occ[0].charging).toBeNull();
  });

  it('0~100 밖 배터리값은 null 처리', async () => {
    const { svc } = makeCharging({ chargers: [charger('C1')], occupant: { C1: 'R1' }, battery: { R1: 250 } });
    expect((await svc.getChargerOccupantsInfo('m1'))[0].battery).toBeNull();
  });
});
