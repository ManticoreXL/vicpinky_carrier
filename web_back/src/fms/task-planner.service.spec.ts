import { TaskPlannerService } from './task-planner.service';
import { TaskStatus, TaskType } from './task.schema';
import { RobotStatus } from '../robot/robot.schema';

// 수동 단건 할당(planTask) 단위 테스트 — NestJS DI/Mongo 없이 직접 인스턴스화 + 목.
// 통합 후 TaskPlannerService는 nav/supply 핸들러를 내부에 흡수했고(11개 의존성),
// 이동은 exec.startPlan, 보급은 rosService.publish(START_TOPIC)로 실제 실행을 위임한다.
function makeDispatch(cfg: { hasServer?: boolean; task?: any; robot?: any; cache?: any; hasActive?: boolean } = {}) {
  const taskRepo   = { getTask: jest.fn(async () => cfg.task ?? null) };
  const taskStatus = {
    setWaitReason: jest.fn(async () => undefined),
    setStatus:     jest.fn(async () => undefined),
    assignToRobot: jest.fn(async () => undefined),
  };
  const robotService = {
    autoRegister: jest.fn(async () => cfg.robot ?? { robot_id: 'R1', lastNode: null }),
    updateStatus: jest.fn(async () => undefined),
    updateNode:   jest.fn(async () => undefined),
  };
  const robotState = { getCache: jest.fn(() => cfg.cache) };
  const events = {
    _has: cfg.hasServer ?? true, get hasServer() { return this._has; },
    server: { emit: jest.fn() }, emit: jest.fn(), broadcast: jest.fn(),
  };
  const robotTasks = { hasActive: jest.fn(() => cfg.hasActive ?? false), getActive: jest.fn(() => 't0'), setActive: jest.fn(), clearActive: jest.fn(), dispatchNext: jest.fn(async () => undefined) };
  // 목적지 직행이 되도록 lastNode=null → planPath가 [targetNode] 반환(pathfinding 미사용)
  const topology = { findNodeById: jest.fn(async (id: string) => ({ node_id: id, map_id: 'm1', x: 1, y: 2, yaw: 0 })) };
  const pathfinding = { findPath: jest.fn(async () => []), findNearestNodeToPosition: jest.fn(async () => null) };
  const nodeLock = { lockNode: jest.fn(async () => undefined) };
  const rosService = { publish: jest.fn(), onMessage: jest.fn() };
  const exec = { startPlan: jest.fn(async () => undefined) };

  const svc = new TaskPlannerService(
    taskRepo as any, taskStatus as any, robotService as any, robotState as any, events as any,
    robotTasks as any, topology as any, pathfinding as any, nodeLock as any, rosService as any, exec as any,
  );
  return { svc, taskRepo, taskStatus, robotService, robotState, events, robotTasks, topology, pathfinding, nodeLock, rosService, exec };
}

const task = (over: Record<string, any> = {}) => ({
  _id: 't1', type: TaskType.MOVE, status: TaskStatus.PENDING,
  preferredRobotId: 'R1', targetNode: 'N1', priority: 5, ...over,
});
const onlineCache = { lastSeen: Date.now(), batteryPct: 80, posX: 0, posY: 0 };

describe('TaskPlannerService.planTask — 수동 단건 할당 (자동 선택 없음)', () => {
  it('PENDING + 온라인 지정로봇 → 이동 실행(exec.startPlan), ok', async () => {
    const { svc, exec, robotTasks } = makeDispatch({ task: task(), robot: { robot_id: 'R1', lastNode: null }, cache: onlineCache });
    const r = await svc.planTask('t1');
    expect(robotTasks.setActive).toHaveBeenCalledWith('R1', 't1');
    expect(exec.startPlan).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it('SUPPLY 타입 → 비전 추론 발행(rosService.publish) + WORKING', async () => {
    const { svc, rosService, robotService, exec } = makeDispatch({ task: task({ type: TaskType.SUPPLY }), robot: { robot_id: 'R1', lastNode: null }, cache: onlineCache });
    await svc.planTask('t1');
    expect(rosService.publish).toHaveBeenCalledTimes(1);
    expect(robotService.updateStatus).toHaveBeenCalledWith('R1', RobotStatus.WORKING);
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it('로봇 미지정(preferredRobotId 없음) → 실행 안 함 + waitReason', async () => {
    const { svc, taskStatus, exec } = makeDispatch({ task: task({ preferredRobotId: null }), cache: onlineCache });
    const r = await svc.planTask('t1');
    expect(r.ok).toBe(false);
    expect(taskStatus.setWaitReason).toHaveBeenCalledWith('t1', expect.stringContaining('로봇'));
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it("preferredRobotId 'null' 문자열도 미지정으로 처리", async () => {
    const { svc, exec } = makeDispatch({ task: task({ preferredRobotId: 'null' }), cache: onlineCache });
    await svc.planTask('t1');
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it('로봇이 이미 작업 중 → PENDING 유지(큐 대기), 실행 안 함', async () => {
    const { svc, exec } = makeDispatch({ task: task(), robot: { robot_id: 'R1' }, cache: onlineCache, hasActive: true });
    const r = await svc.planTask('t1');
    expect(r.ok).toBe(true);
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it('지정 로봇 오프라인(stale cache) → 실행 안 함 + waitReason', async () => {
    const { svc, taskStatus, exec } = makeDispatch({ task: task(), robot: { robot_id: 'R1' }, cache: { lastSeen: 0 } });
    const r = await svc.planTask('t1');
    expect(r.ok).toBe(false);
    expect(taskStatus.setWaitReason).toHaveBeenCalledWith('t1', expect.stringContaining('오프라인'));
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it('PENDING 상태가 아니면 실행 안 함', async () => {
    const { svc, exec } = makeDispatch({ task: task({ status: TaskStatus.RUNNING }), robot: { robot_id: 'R1' }, cache: onlineCache });
    const r = await svc.planTask('t1');
    expect(r.ok).toBe(false);
    expect(exec.startPlan).not.toHaveBeenCalled();
  });

  it('소켓 서버 없으면 즉시 반환(태스크 조회조차 안 함)', async () => {
    const { svc, taskRepo, exec } = makeDispatch({ hasServer: false });
    const r = await svc.planTask('t1');
    expect(r.ok).toBe(false);
    expect(taskRepo.getTask).not.toHaveBeenCalled();
    expect(exec.startPlan).not.toHaveBeenCalled();
  });
});
