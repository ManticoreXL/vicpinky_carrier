import { CollisionAvoidanceService, RobotPathState } from './collision-avoidance.service';

// evaluate()는 순수 의사결정 — 노드 좌표 조회만 토폴로지에 의존하므로 stub으로 대체한다.
// node 'X'는 (0,0), 그 외는 멀리 떨어진 좌표로 둬서 "같은 노드 경쟁"만 검증한다.
const stubTopo = {
  findNodeById: async (id: string) => (id === 'X' ? { x: 0, y: 0 } : { x: 999, y: 999 }),
} as any;

function svc() { return new CollisionAvoidanceService(stubTopo); }

const robot = (robotId: string, priority: number, order: number, next: string): RobotPathState => ({
  robotId, priority, order, pathQueue: [next, 'Y'], posX: 999, posY: 999, // 위치는 멀리 → 'sameTarget'로만 충돌
});

describe('CollisionAvoidanceService.evaluate — 우선순위 양보', () => {
  it('우선순위가 높은(숫자 작은) 로봇이 가고, 낮은 로봇만 양보 정지한다', async () => {
    const s = svc();
    const decisions = await s.evaluate([
      robot('A', 1, 0, 'X'), // 우선순위 1 (긴급)
      robot('B', 5, 0, 'X'), // 우선순위 5 — 같은 노드 X를 노림
    ]);
    expect(decisions).toContainEqual(expect.objectContaining({ robotId: 'B', action: 'stop', conflictNode: 'X' }));
    expect(decisions.find(d => d.robotId === 'A')).toBeUndefined(); // A는 그대로 진행
    expect(s.isWaiting('B')).toBe(true);
    expect(s.isWaiting('A')).toBe(false);
  });

  it('우선순위가 같으면 TASK를 먼저 받은(order 작은) 로봇이 간다', async () => {
    const s = svc();
    const decisions = await s.evaluate([
      robot('A', 5, 200, 'X'), // 같은 우선순위, 늦게 받음
      robot('B', 5, 100, 'X'), // 먼저 받음 → 우선
    ]);
    expect(decisions).toContainEqual(expect.objectContaining({ robotId: 'A', action: 'stop' }));
    expect(decisions.find(d => d.robotId === 'B')).toBeUndefined();
  });

  it('충돌이 풀리면(상대가 사라지면) 양보했던 로봇이 재출발한다', async () => {
    const s = svc();
    await s.evaluate([robot('A', 1, 0, 'X'), robot('B', 5, 0, 'X')]); // B 양보
    expect(s.isWaiting('B')).toBe(true);
    const next = await s.evaluate([robot('B', 5, 0, 'X')]); // A 사라짐 → B 단독
    expect(next).toContainEqual(expect.objectContaining({ robotId: 'B', action: 'resume' }));
    expect(s.isWaiting('B')).toBe(false);
  });
});
