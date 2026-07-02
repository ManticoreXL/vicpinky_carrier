import { AutoChargerService } from './auto-charger.service';
import { TaskType } from './task.schema';
import { RobotStatus } from '../robot/robot.schema';

// 자동충전 대상 선별(needy 필터) 단위 테스트 — NestJS DI/Mongo 없이 직접 인스턴스화 + 목.
// 핵심: 큐 깊이(배정 PENDING + 진행 중)가 0인 "완전히 노는" 로봇만 충전을 보낸다.
function makeCharger(cfg: {
  robots?: any[];
  depths?: Record<string, number>;
  needsCharge?: boolean;
  freeChargers?: Array<{ node_id: string }>;
} = {}) {
  const robotService = {
    findAll:      jest.fn(async () => cfg.robots ?? []),
    updateStatus: jest.fn(async () => undefined),
  };
  const topology = {
    findNodesByType:      jest.fn(async () => [{ node_id: 'C1', x: 5, y: 0 }]),
    findInitPositionNode: jest.fn(async () => ({ node_id: 'INIT', x: 0, y: 0 })),
  };
  const pathfinding = { hopDistanceFromPosition: jest.fn(async () => 1) };
  const robotState  = { getCache: jest.fn(() => undefined) }; // 위치 캐시 없음 → nearestCharger는 첫 충전소 반환
  const robotTasks  = {
    hasActive:   jest.fn(() => false),
    queueDepths: jest.fn(async () => new Map(Object.entries(cfg.depths ?? {}))),
  };
  const globalQueue = { enqueue: jest.fn(async () => ({ _id: 'charge-task' })) };
  const charging    = { getFreeChargers: jest.fn(async () => cfg.freeChargers ?? [{ node_id: 'C1' }]) };
  const nodeLock    = { lockNode: jest.fn(async () => undefined) };
  const planner     = { planTask: jest.fn(async () => ({ ok: true })) };
  const monitor     = { needsCharge: jest.fn(() => cfg.needsCharge ?? true) };
  const events      = { hasServer: true, emit: jest.fn(), broadcast: jest.fn() };

  const svc = new AutoChargerService(
    robotService as any, topology as any, pathfinding as any, robotState as any, robotTasks as any,
    globalQueue as any, charging as any, nodeLock as any, planner as any, monitor as any, events as any,
  );
  return { svc, globalQueue, planner, robotTasks, monitor };
}

// 초기위치·충전소에 있지 않은 저배터리 IDLE 로봇
const robot = (over: Record<string, any> = {}) => ({
  robot_id: 'R1', location: 'm1', status: RobotStatus.IDLE, online: true, lastNode: 'N0', battery: 15, ...over,
});

describe('AutoChargerService — 충전 대상 선별(큐가 항상 우선)', () => {
  it('큐가 빈(depth 0) 저배터리 로봇 → CHARGE 태스크 생성 + 즉시 디스패치', async () => {
    const { svc, globalQueue, planner } = makeCharger({ robots: [robot()], depths: {} });
    svc.setAutoCharge(true);
    await svc.runIfEnabled();
    expect(globalQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: TaskType.CHARGE, targetNode: 'C1', preferredRobotId: 'R1' }));
    expect(planner.planTask).toHaveBeenCalledTimes(1);
  });

  it('배정된 PENDING이 남은 로봇(depth>0) → 충전 안 보냄 (완료 틈 레이스 차단, 큐 우선)', async () => {
    const { svc, globalQueue } = makeCharger({ robots: [robot()], depths: { R1: 2 } });
    svc.setAutoCharge(true);
    await svc.runIfEnabled();
    expect(globalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('작업 진행 중 로봇(depth에 active 1건 포함) → 충전 안 보냄', async () => {
    const { svc, globalQueue } = makeCharger({ robots: [robot({ status: RobotStatus.WORKING })], depths: { R1: 1 } });
    svc.setAutoCharge(true);
    await svc.runIfEnabled();
    expect(globalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('충전 필요 없는 로봇 → 안 보냄', async () => {
    const { svc, globalQueue } = makeCharger({ robots: [robot()], needsCharge: false });
    svc.setAutoCharge(true);
    await svc.runIfEnabled();
    expect(globalQueue.enqueue).not.toHaveBeenCalled();
  });

  it('자동충전 OFF → 아무것도 안 함', async () => {
    const { svc, globalQueue, robotTasks } = makeCharger({ robots: [robot()] });
    await svc.runIfEnabled();
    expect(globalQueue.enqueue).not.toHaveBeenCalled();
    expect(robotTasks.queueDepths).not.toHaveBeenCalled();
  });
});
