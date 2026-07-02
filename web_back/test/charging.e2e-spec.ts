import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { Robot, RobotSchema, RobotStatus } from '../src/robot/robot.schema';
import { Node, NodeSchema, NodeType } from '../src/topology/node.schema';
import { Edge, EdgeSchema, EdgeDirection } from '../src/topology/edge.schema';
import { TaskHistory, TaskHistorySchema, TaskType } from '../src/fms/task.schema';

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

const MONGO = 'mongodb://127.0.0.1:27017/fms_charge_verify';
const MAP = 'chargemap';
const BOT = 'TEST-BOT1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(200);
  }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

// 수동 충전: 사용자가 로봇과 충전소 노드를 지정 → CHARGE 태스크 실행 → 도착 시 CHARGING (자동 선택 없음)
describe('수동 충전 (virtual test-bot + MongoDB)', () => {
  let app: any;
  let tm: TaskManagerService;
  let topo: TopologyService;
  let robots: RobotService;
  let state: RobotStateService;

  jest.setTimeout(120_000);

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
    topo   = app.get(TopologyService);
    robots = app.get(RobotService);
    state  = app.get(RobotStateService);
    tm.setServer({ emit() {} } as any);

    // N1(0,0) 시작점, C1(3,0)/C2(6,0) 충전소, N1에서 직접 연결.
    const mk = (id: string, x: number, y: number, type: NodeType) =>
      topo.createNode({ node_id: id, map_id: MAP, type, x, y, yaw: 0, isLocked: false });
    await mk('N1', 0, 0, NodeType.WAYPOINT);
    await mk('C1', 3, 0, NodeType.CHARGER);
    await mk('C2', 6, 0, NodeType.CHARGER);
    const edge = (id: string, a: string, b: string) =>
      topo.createEdge({ edge_id: id, map_id: MAP, startNode: a, endNode: b, direction: EdgeDirection.BOTH_WAY, weight: 1, isLocked: false });
    await edge('E1', 'N1', 'C1');
    await edge('E2', 'N1', 'C2');
  });

  afterAll(async () => { await app?.close(); });

  it('test-bot 온라인', async () => {
    await waitFor(() => { const c = state.getCache(BOT); return !!c && Date.now() - c.lastSeen < 5000; }, 15_000, 'bot online');
  });

  it('수동 충전: 로봇을 충전소 C1로 보내기 → 도착 시 CHARGING', async () => {
    const task = await tm.enqueue({ type: TaskType.CHARGE, targetNode: 'C1', preferredRobotId: BOT });
    const res = await tm.dispatchTask(String((task as any)._id));
    expect(res.ok).toBe(true);

    await waitFor(async () => (await robots.findById(BOT))?.status === RobotStatus.CHARGING, 40_000, 'CHARGING');
    expect((await robots.findById(BOT))?.lastNode).toBe('C1'); // 충전소 노드 도착
  });
});
