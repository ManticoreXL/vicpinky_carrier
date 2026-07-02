import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { Robot, RobotSchema } from '../src/robot/robot.schema';
import { Node, NodeSchema, NodeType } from '../src/topology/node.schema';
import { Edge, EdgeSchema, EdgeDirection } from '../src/topology/edge.schema';
import { TaskHistory, TaskHistorySchema, TaskType, TaskStatus } from '../src/fms/task.schema';

import { RobotService } from '../src/robot/robot.service';
import { TopologyService } from '../src/topology/topology.service';
import { PathfindingService } from '../src/pathfinding/pathfinding.service';
import { NodeOccupancyService } from '../src/node-occupancy/node-occupancy.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { RosService } from '../src/ros/ros.service';
import { VirtualRobotService } from '../src/ros/virtual-robot/virtual-robot.service';
import { DomainBridgeService } from '../src/ros/domain-bridge/domain-bridge.service';

import { TaskRepositoryService } from '../src/fms/task-repository.service';
import { TaskStatusService } from '../src/fms/task-status.service';
import { TaskManagerEventsService } from '../src/fms-events/task-manager-events.service';
import { RobotStateService } from '../src/fms-state/robot-state.service';
import { RobotTaskQueueService } from '../src/fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from '../src/fms/global-task-queue.service';
import { ChargingService } from '../src/fms/charging.service';
import { NodeLockService } from '../src/fms/node-lock.service';
import { TaskExecutionService } from '../src/fms/task-execution.service';
import { TaskPlannerService } from '../src/fms/task-planner.service';
import { RobotMonitorService } from '../src/fms/robot-monitor.service';
import { AutoDispatcherService } from '../src/fms/auto-dispatcher.service';
import { AutoChargerService } from '../src/fms/auto-charger.service';
import { AutoTaskService } from '../src/fms/auto-task.service';
import { CoreEventBus } from '../src/core-events/core-events.service';
import { TaskManagerService } from '../src/fms/task-manager.service';
import { CollisionAvoidanceService } from '../src/collision-avoidance/collision-avoidance.service';
import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';

const MONGO = 'mongodb://127.0.0.1:27017/fms_navaction_verify';
const TESTBOT = 'TEST-BOT1'; // 가상 테스트봇 — amcl 기반 도착
const TB3 = 'tb3_01';        // 실 터틀봇(취급) — navigate_to_pose 액션 기반 도착

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await pred()) return; await sleep(150); }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

// 액션 goal 캡처 — sendActionGoal 스파이가 채운다. onResult로 nav2 결과(SUCCEEDED/ABORTED) 주입.
type NavGoal = { actionName: string; goal: any; onResult: (r: any) => void };

describe('터틀봇 navigate_to_pose 액션 nav (실봇=액션 / 테스트봇=amcl) — virtual + MongoDB', () => {
  let app: any;
  let tm:    TaskManagerService;
  let fms:   TaskRepositoryService;
  let topo:  TopologyService;
  let robots: RobotService;
  let state: RobotStateService;
  let ros:   RosService;
  let navGoals: NavGoal[] = [];
  let amclTimer: NodeJS.Timeout;

  jest.setTimeout(120_000);

  const tb3Goals = () => navGoals.filter((g) => g.actionName === `/${TB3}/navigate_to_pose`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO),
        MongooseModule.forFeature([
          { name: Robot.name, schema: RobotSchema },
          { name: Node.name,  schema: NodeSchema  },
          { name: Edge.name,  schema: EdgeSchema  },
          { name: TaskHistory.name,  schema: TaskHistorySchema  },
        ]),
        TaskCatalogModule,
      ],
      providers: [
        RobotService, TopologyService, PathfindingService, NodeOccupancyService, TelemetryService,
        RosService, VirtualRobotService,
        { provide: DomainBridgeService, useValue: { getCapabilities: () => null, getMap: () => ({ robots: [] }) } },
        TaskRepositoryService, TaskStatusService, TaskManagerEventsService, RobotStateService, RobotTaskQueueService,
        GlobalTaskQueueService, ChargingService, NodeLockService,
        TaskExecutionService, TaskPlannerService,
        RobotMonitorService, AutoDispatcherService, AutoChargerService, AutoTaskService,
        TaskManagerService, CoreEventBus, CollisionAvoidanceService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const conn = app.get(getConnectionToken()) as Connection;
    await conn.dropDatabase();

    tm     = app.get(TaskManagerService);
    fms    = app.get(TaskRepositoryService);
    topo   = app.get(TopologyService);
    robots = app.get(RobotService);
    state  = app.get(RobotStateService);
    ros    = app.get(RosService);

    tm.setServer({ emit() {} } as any);

    // 직선 토폴로지: N1(0,0)-N2(2,0)-N3(4,0)
    const mk = (id: string, x: number) => topo.createNode({ node_id: id, map_id: 'navmap', type: NodeType.WAYPOINT, x, y: 0, yaw: 0, isLocked: false });
    await mk('N1', 0); await mk('N2', 2); await mk('N3', 4);
    const edge = (id: string, a: string, b: string) => topo.createEdge({ edge_id: id, map_id: 'navmap', startNode: a, endNode: b, direction: EdgeDirection.BOTH_WAY, weight: 2, isLocked: false });
    await edge('E1', 'N1', 'N2'); await edge('E2', 'N2', 'N3');

    // tb3_01(실봇 취급) — navmap/N1 배치 + amcl 주기 주입으로 온라인 유지 (도착판정엔 안 씀, 온라인/표시용)
    await robots.autoRegister(TB3);
    await robots.setInitialPose(TB3, 'navmap', 0, 0, 0, 'N1');
    amclTimer = setInterval(() => {
      ros.injectMessage({ topic: `/${TB3}/amcl_pose`, data: { pose: { pose: { position: { x: 0, y: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } } }, timestamp: Date.now() });
    }, 400);

    // sendActionGoal 스파이 — nav2 대신 테스트가 result를 주입. (실 rosbridge 없음)
    jest.spyOn(ros, 'sendActionGoal').mockImplementation((payload: any, _fb: any, onResult: any) => {
      const goalId = `goal_${navGoals.length + 1}`;
      navGoals.push({ actionName: payload.actionName, goal: payload.goal, onResult });
      return goalId;
    });
  });

  afterAll(async () => {
    clearInterval(amclTimer);
    jest.restoreAllMocks();
    await sleep(300); // 진행 중 상태 틱(DB) 마무리 대기 후 종료
    try { await app?.close(); } catch { /* 백그라운드 타이머와 Mongo close 경쟁 — 무해 */ }
  });

  it('TEST-BOT은 amcl로 도착한다 (액션 안 씀) → MOVE 완료', async () => {
    // 가상봇 온라인 대기
    await waitFor(() => { const c = state.getCache(TESTBOT); return !!c && Date.now() - c.lastSeen < 5000; }, 15_000, 'test-bot online');

    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: TESTBOT });
    const id = String((task as any)._id);
    expect((await tm.dispatchTask(id)).ok).toBe(true);

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, 'TEST-BOT COMPLETED');
    expect((await robots.findById(TESTBOT))?.lastNode).toBe('N3');
    // ★ TEST-BOT은 navigate_to_pose 액션을 쓰지 않았다
    expect(navGoals.filter((g) => g.actionName.includes('TEST-BOT'))).toHaveLength(0);
  });

  it('터틀봇은 navigate_to_pose 액션 result로 노드 순차 도착 → 최종 SUCCEEDED에 완료', async () => {
    await waitFor(() => { const c = state.getCache(TB3); return !!c && Date.now() - c.lastSeen < 5000; }, 8_000, 'tb3 online');
    const base = tb3Goals().length;

    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: TB3 });
    const id = String((task as any)._id);
    expect((await tm.dispatchTask(id)).ok).toBe(true);

    // 1번째 액션 goal = N2 (출발 N1 제외)
    await waitFor(() => tb3Goals().length >= base + 1, 8_000, 'nav goal #1');
    const g1 = tb3Goals()[base];
    expect(g1.actionName).toBe(`/${TB3}/navigate_to_pose`);
    expect(g1.goal.pose.pose.position.x).toBeCloseTo(2, 1); // N2
    // amcl 임계로는 절대 진행 안 함을 확인: amcl을 N2에 줘도 advance 안 일어남(아래 result로만 진행)

    g1.onResult({ goalId: 'g1', actionName: g1.actionName, result: {}, status: 3 }); // SUCCEEDED → 다음 노드

    // 2번째 액션 goal = N3
    await waitFor(() => tb3Goals().length >= base + 2, 8_000, 'nav goal #2');
    const g2 = tb3Goals()[base + 1];
    expect(g2.goal.pose.pose.position.x).toBeCloseTo(4, 1); // N3

    // 아직 미완료(최종 result 전)
    expect((await fms.getTask(id))?.status).not.toBe(TaskStatus.COMPLETED);

    g2.onResult({ goalId: 'g2', actionName: g2.actionName, result: {}, status: 3 }); // 최종 SUCCEEDED → 완료

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 8_000, 'tb3 COMPLETED');
    expect((await robots.findById(TB3))?.lastNode).toBe('N3');
  });

  it('터틀봇 nav 중 ABORTED(에러) → 태스크 자동 FAILED', async () => {
    await robots.setInitialPose(TB3, 'navmap', 0, 0, 0, 'N1'); // 다시 N1에서 출발
    const base = tb3Goals().length;

    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: TB3 });
    const id = String((task as any)._id);
    expect((await tm.dispatchTask(id)).ok).toBe(true);

    await waitFor(() => tb3Goals().length >= base + 1, 8_000, 'abort nav goal');
    const g = tb3Goals()[base];
    g.onResult({ goalId: 'ga', actionName: g.actionName, result: {}, status: 4 }); // ABORTED

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.FAILED, 8_000, 'tb3 FAILED');
    const failed = await fms.getTask(id);
    expect(failed?.status).toBe(TaskStatus.FAILED);
    expect(failed?.errorMessage).toContain('ABORTED');
    expect((await robots.findById(TB3))?.status).toBe('IDLE'); // 실패 후 IDLE
  });
});
