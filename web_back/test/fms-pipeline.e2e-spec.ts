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
import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';

const MONGO = 'mongodb://127.0.0.1:27017/fms_verify';
const BOT = 'TEST-BOT1'; // 백엔드 내장 가상 테스트봇

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(250);
  }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

// 수동 단일명령 모델: enqueue(태스크 생성) → dispatchTask(지정 robotId로 실행)
describe('FMS 수동 단일명령 (virtual test-bot + MongoDB)', () => {
  let app: any;
  let tm: TaskManagerService;
  let fms: TaskRepositoryService;
  let topo: TopologyService;
  let robots: RobotService;
  let state: RobotStateService;

  jest.setTimeout(120_000);

  const dispatch = async (dto: { type: TaskType; targetNode: string }) => {
    const task = await tm.enqueue({ ...dto, preferredRobotId: BOT });
    const id = String((task as any)._id);
    const res = await tm.dispatchTask(id); // 사용자가 BOT을 지정해 수동 실행
    return { id, res };
  };

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
        { provide: DomainBridgeService, useValue: { getCapabilities: () => null } },
        TaskRepositoryService, TaskStatusService, TaskManagerEventsService, RobotStateService, RobotTaskQueueService,
        GlobalTaskQueueService, ChargingService, NodeLockService,
        TaskExecutionService, TaskPlannerService,
        RobotMonitorService, AutoDispatcherService, AutoChargerService, AutoTaskService,
        TaskManagerService, CoreEventBus,
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

    tm.setServer({ emit() {} } as any);

    // 토폴로지: 직선 N1(0,0)-N2(2,0)-N3(4,0), 우회 N1-N4(2,2)-N3
    const mk = (id: string, x: number, y: number) => topo.createNode({ node_id: id, map_id: 'verifymap', type: NodeType.WAYPOINT, x, y, yaw: 0, isLocked: false });
    await mk('N1', 0, 0); await mk('N2', 2, 0); await mk('N3', 4, 0); await mk('N4', 2, 2);
    const edge = (id: string, a: string, b: string, w: number) => topo.createEdge({ edge_id: id, map_id: 'verifymap', startNode: a, endNode: b, direction: EdgeDirection.BOTH_WAY, weight: w, isLocked: false });
    await edge('E1', 'N1', 'N2', 1); await edge('E2', 'N2', 'N3', 1);
    await edge('E3', 'N1', 'N4', 3); await edge('E4', 'N4', 'N3', 3);
  });

  afterAll(async () => { await app?.close(); });

  it('test-bot이 온라인이 된다', async () => {
    await waitFor(() => {
      const c = state.getCache(BOT);
      return !!c && Date.now() - c.lastSeen < 5000;
    }, 15_000, 'test-bot online');
    expect(state.getCache(BOT)!.posX).toBeCloseTo(0, 1);
  });

  it('수동 할당: 로봇을 N3로 보내기 → 주행→완료', async () => {
    const { id, res } = await dispatch({ type: TaskType.MOVE, targetNode: 'N3' });
    expect(res.ok).toBe(true); // 지정 로봇으로 실행 시작

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, 'task COMPLETED');

    const done = await fms.getTask(id);
    expect(done?.status).toBe(TaskStatus.COMPLETED);
    expect(done?.fullPath).toEqual(['N2', 'N3']); // N1은 출발지라 큐에서 제외
    expect((await robots.findById(BOT))?.lastNode).toBe('N3'); // lastNode=현재 노드
  });

  it('로봇 미지정 태스크는 수동 할당가 거부된다(자동 선택 없음)', async () => {
    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N1' }); // preferredRobotId 없음
    const res = await tm.dispatchTask(String((task as any)._id));
    expect(res.ok).toBe(false); // robotId 필수
  });

  it('노드 폐쇄 시 다음 명령의 경로계산이 우회한다(자동 우회 아님)', async () => {
    // 직전 테스트로 로봇은 N3. N2 폐쇄 후 N1으로 보내면 경로가 N4 우회로 잡힌다.
    await tm.lockNode('N2', true);
    const { id } = await dispatch({ type: TaskType.MOVE, targetNode: 'N1' });

    const t = await fms.getTask(id);
    expect(t?.fullPath).toContain('N4'); // 폐쇄 노드 회피(pathfinding isLocked) — fullPath는 배정 시 경로(소비 안 됨)
    expect(t?.fullPath).not.toContain('N2');

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, 'rerouted COMPLETED');
    expect((await robots.findById(BOT))?.lastNode).toBe('N1');
    await tm.lockNode('N2', false);
  });
});
