import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { Robot, RobotSchema } from '../src/robot/robot.schema';
import { Node, NodeSchema, NodeType } from '../src/topology/node.schema';
import { Edge, EdgeSchema } from '../src/topology/edge.schema';
import { TaskHistory, TaskHistorySchema, TaskStatus } from '../src/fms/task.schema';

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

const MONGO = 'mongodb://127.0.0.1:27017/fms_stopbatch_verify';
const TB = 'TEST-BOT1';
const BATCH = 'BATCH-STOP-1';
const BN = 'BN'; // 배치 목적지 노드

describe('연속(batch) 정지 시 목적지 노드 잠금 해제 + 점유 해제 — virtual + MongoDB', () => {
  let app: any;
  let taskManager: TaskManagerService;
  let topo: TopologyService;
  let robots: RobotService;
  let robotTasks: RobotTaskQueueService;
  let occupancy: NodeOccupancyService;
  let nodeLock: NodeLockService;
  let taskModel: any;

  jest.setTimeout(120_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO),
        MongooseModule.forFeature([
          { name: Robot.name, schema: RobotSchema },
          { name: Node.name,  schema: NodeSchema  },
          { name: Edge.name,  schema: EdgeSchema  },
          { name: TaskHistory.name, schema: TaskHistorySchema },
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
        TaskManagerService, CoreEventBus, CollisionAvoidanceService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const conn = app.get(getConnectionToken()) as Connection;
    await conn.dropDatabase();

    taskManager = app.get(TaskManagerService);
    topo        = app.get(TopologyService);
    robots      = app.get(RobotService);
    robotTasks  = app.get(RobotTaskQueueService);
    occupancy   = app.get(NodeOccupancyService);
    nodeLock    = app.get(NodeLockService);
    taskModel   = app.get(getModelToken(TaskHistory.name));

    taskManager.setServer({ emit() {} } as any);

    await topo.createNode({ node_id: BN, map_id: 'm', type: NodeType.WAYPOINT, x: 4, y: 0, yaw: 0, isLocked: false });
    await robots.autoRegister(TB);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    try { await app?.close(); } catch { /* 타이머/Mongo close 경쟁 — 무해 */ }
  });

  it('정지하면 RUNNING 스텝의 목적지 노드가 잠금 해제되고 점유도 풀린다', async () => {
    // 연속(batch) 2건: 첫 스텝 RUNNING(active) + 둘째 PENDING — 같은 목적지 BN
    await taskModel.create({ task_id: 'SB1', type: 'MOVE', status: TaskStatus.RUNNING, targetNode: BN, assignedRobotId: TB, preferredRobotId: TB, batchId: BATCH, seq: 0 });
    await taskModel.create({ task_id: 'SB2', type: 'MOVE', status: TaskStatus.PENDING, targetNode: BN, assignedRobotId: TB, preferredRobotId: TB, batchId: BATCH, seq: 1 });
    const t1 = await taskModel.findOne({ task_id: 'SB1' });
    robotTasks.setActive(TB, String(t1._id));

    // 실제 주행 중 상태 재현: 목적지 잠금 + 점유(도착 노드) 설정
    await nodeLock.lockNode(BN, true);
    occupancy.occupy(TB, BN);

    // 전제: 잠김 + 점유 상태
    expect((await topo.findNodeById(BN))?.isLocked).toBe(true);
    expect(occupancy.getOccupant(BN)).toBe(TB);
    expect(occupancy.getOccupiedNode(TB)).toBe(BN);

    // 연속 정지
    const res = await taskManager.stopBatch(BATCH);
    expect(res.ok).toBe(true);

    // 검증: 목적지 노드 잠금 해제
    expect((await topo.findNodeById(BN))?.isLocked).toBe(false);
    // 검증: 점유 해제 (노드·로봇 양방향)
    expect(occupancy.getOccupant(BN)).toBeUndefined();
    expect(occupancy.getOccupiedNode(TB)).toBeUndefined();
    // 검증: 두 스텝 모두 COMPLETED, active 비고 로봇 IDLE
    expect((await taskModel.findOne({ task_id: 'SB1' }))?.status).toBe(TaskStatus.COMPLETED);
    expect((await taskModel.findOne({ task_id: 'SB2' }))?.status).toBe(TaskStatus.COMPLETED);
    expect(robotTasks.getActive(TB)).toBeUndefined();
    expect((await robots.findById(TB))?.status).toBe('IDLE');
  });
});
