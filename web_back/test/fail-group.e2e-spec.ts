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

const MONGO = 'mongodb://127.0.0.1:27017/fms_failgroup_verify';
const TB = 'TEST-BOT1';

describe('주행 실패(failTask) 그룹 정책 — 연속/시나리오는 한 스텝 실패 시 그룹 전체 FAILED(반납 없음), 단건은 글로벌 큐 반납', () => {
  let app: any;
  let taskManager: TaskManagerService;
  let topo: TopologyService;
  let robots: RobotService;
  let robotTasks: RobotTaskQueueService;
  let occupancy: NodeOccupancyService;
  let nodeLock: NodeLockService;
  let exec: TaskExecutionService;
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

    taskManager = app.get(TaskManagerService);
    topo        = app.get(TopologyService);
    robots      = app.get(RobotService);
    robotTasks  = app.get(RobotTaskQueueService);
    occupancy   = app.get(NodeOccupancyService);
    nodeLock    = app.get(NodeLockService);
    exec        = app.get(TaskExecutionService);
    taskModel   = app.get(getModelToken(TaskHistory.name));

    taskManager.setServer({ emit() {} } as any);

    for (const id of ['BN1', 'BN2', 'BN3', 'SN1', 'SN2', 'SN3', 'ONE']) {
      await topo.createNode({ node_id: id, map_id: 'm', type: NodeType.WAYPOINT, x: 1, y: 0, yaw: 0, isLocked: false });
    }
    await robots.autoRegister(TB);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    try { await app?.close(); } catch { /* 타이머/Mongo close 경쟁 — 무해 */ }
  });

  it('연속(batchId): 한 스텝 주행 실패 → 미완료 스텝 전부 FAILED, 새 PENDING 재등록 없음, 잠금·점유 해제 + 로봇 IDLE', async () => {
    const BATCH = 'BATCH-FAIL-1';
    const t1 = await taskModel.create({ task_id: 'BF1', type: 'MOVE', status: TaskStatus.RUNNING, targetNode: 'BN1', assignedRobotId: TB, preferredRobotId: TB, batchId: BATCH, seq: 0 });
    await taskModel.create({ task_id: 'BF2', type: 'MOVE', status: TaskStatus.PENDING, targetNode: 'BN2', preferredRobotId: TB, batchId: BATCH, seq: 1 });
    await taskModel.create({ task_id: 'BF3', type: 'MOVE', status: TaskStatus.PENDING, targetNode: 'BN3', preferredRobotId: TB, batchId: BATCH, seq: 2 });
    robotTasks.setActive(TB, String(t1._id));

    // 실제 주행 중 상태 재현: 진행/예정 목적지 잠금 + 현재 노드 점유
    await nodeLock.lockNode('BN1', true);
    await nodeLock.lockNode('BN2', true);
    occupancy.occupy(TB, 'BN1');

    await (exec as any).failTask(TB, String(t1._id), 'navigate_to_pose ABORTED @ BN1');

    // 그룹 전체 FAILED — 반납(새 PENDING) 없음
    for (const id of ['BF1', 'BF2', 'BF3']) {
      expect((await taskModel.findOne({ task_id: id }))?.status).toBe(TaskStatus.FAILED);
    }
    expect(await taskModel.countDocuments({ batchId: BATCH })).toBe(3);
    expect(await taskModel.countDocuments({ status: TaskStatus.PENDING })).toBe(0);
    expect((await taskModel.findOne({ task_id: 'BF2' }))?.errorMessage).toContain('연속 전체 실패');

    // 로봇 상태 정리: active 해제 + IDLE + 잠금·점유 해제
    expect(robotTasks.getActive(TB)).toBeUndefined();
    expect((await robots.findById(TB))?.status).toBe('IDLE');
    expect((await topo.findNodeById('BN1'))?.isLocked).toBe(false);
    expect((await topo.findNodeById('BN2'))?.isLocked).toBe(false);
    expect(occupancy.getOccupiedNode(TB)).toBeUndefined();
  });

  it('시나리오(scenarioId): 한 스텝 주행 실패 → 완료 스텝은 유지, 미완료 스텝 전부 FAILED, 반납 없음', async () => {
    const SCN = 'SCN-FAIL-1';
    await taskModel.create({ task_id: 'SF1', type: 'MOVE', status: TaskStatus.COMPLETED, targetNode: 'SN1', assignedRobotId: TB, scenarioId: SCN, seq: 0 });
    const t2 = await taskModel.create({ task_id: 'SF2', type: 'MOVE', status: TaskStatus.RUNNING, targetNode: 'SN2', assignedRobotId: TB, scenarioId: SCN, seq: 1 });
    await taskModel.create({ task_id: 'SF3', type: 'MOVE', status: TaskStatus.PENDING, targetNode: 'SN3', scenarioId: SCN, seq: 2 });
    robotTasks.setActive(TB, String(t2._id));

    await (exec as any).failTask(TB, String(t2._id), 'navigate_to_pose ABORTED @ SN2');

    expect((await taskModel.findOne({ task_id: 'SF1' }))?.status).toBe(TaskStatus.COMPLETED); // 이미 완료된 스텝은 유지
    expect((await taskModel.findOne({ task_id: 'SF2' }))?.status).toBe(TaskStatus.FAILED);
    expect((await taskModel.findOne({ task_id: 'SF3' }))?.status).toBe(TaskStatus.FAILED);
    expect((await taskModel.findOne({ task_id: 'SF3' }))?.errorMessage).toContain('시나리오 전체 실패');
    expect(await taskModel.countDocuments({ scenarioId: SCN })).toBe(3); // 새 PENDING 재등록 없음
    expect(await taskModel.countDocuments({ status: TaskStatus.PENDING })).toBe(0);
    expect(robotTasks.getActive(TB)).toBeUndefined();
    expect((await robots.findById(TB))?.status).toBe('IDLE');
  });

  it('단건: 주행 실패 → 원본 FAILED + 같은 내용의 새 PENDING(미배정) 1건 반납', async () => {
    const t = await taskModel.create({ task_id: 'ONE1', type: 'MOVE', status: TaskStatus.RUNNING, targetNode: 'ONE', assignedRobotId: TB, preferredRobotId: TB });
    robotTasks.setActive(TB, String(t._id));

    await (exec as any).failTask(TB, String(t._id), 'navigate_to_pose ABORTED @ ONE');

    expect((await taskModel.findOne({ task_id: 'ONE1' }))?.status).toBe(TaskStatus.FAILED);
    const requeued = await taskModel.find({ status: TaskStatus.PENDING });
    expect(requeued).toHaveLength(1); // 단건만 글로벌 큐 반납
    expect(requeued[0].targetNode).toBe('ONE');
    expect(requeued[0].assignedRobotId ?? null).toBeNull(); // 미배정 — 수동 dispatch 대기
    expect(requeued[0].batchId ?? null).toBeNull();
    expect(requeued[0].scenarioId ?? null).toBeNull();
    expect(robotTasks.getActive(TB)).toBeUndefined();
    expect((await robots.findById(TB))?.status).toBe('IDLE');
  });
});
