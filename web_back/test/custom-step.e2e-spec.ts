import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { Robot, RobotSchema } from '../src/robot/robot.schema';
import { Node, NodeSchema, NodeType } from '../src/topology/node.schema';
import { Edge, EdgeSchema, EdgeDirection } from '../src/topology/edge.schema';
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
import { TaskExecutionService, serviceStep, topicStep, waitStep } from '../src/fms/task-execution.service';
import { TaskPlannerService } from '../src/fms/task-planner.service';
import { RobotMonitorService } from '../src/fms/robot-monitor.service';
import { AutoDispatcherService } from '../src/fms/auto-dispatcher.service';
import { AutoChargerService } from '../src/fms/auto-charger.service';
import { AutoTaskService } from '../src/fms/auto-task.service';
import { CoreEventBus } from '../src/core-events/core-events.service';
import { TaskManagerService } from '../src/fms/task-manager.service';
import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';

const MONGO = 'mongodb://127.0.0.1:27017/fms_customstep_verify';
const TB3 = 'tb3_01';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await pred()) return; await sleep(120); }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

// move 스텝(실 터틀봇 → navigate_to_pose 액션) 수동 생성
const moveStep = (nodeId: string, x: number) => ({
  kind: 'move', topicName: `/${TB3}/goal_pose`, messageType: 'geometry_msgs/PoseStamped',
  message: { pose: { position: { x, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
  awaitNodeId: nodeId, awaitKind: 'arrival' as const,
});

describe('혼합 스텝(move/service/topic/wait) 순차 실행 — virtual + MongoDB', () => {
  let app: any;
  let exec:  TaskExecutionService;
  let fms:   TaskRepositoryService;
  let topo:  TopologyService;
  let robots: RobotService;
  let robotTasks: RobotTaskQueueService;
  let ros:   RosService;
  let taskModel: any;
  let navGoals: { goal: any; onResult: (r: any) => void }[] = [];
  let svcCalls: { payload: any; cb: (res: any) => void }[] = [];

  jest.setTimeout(120_000);

  // 태스크를 RUNNING+active로 만들고 커스텀 플랜 시작
  const startTask = async (taskId: string, plan: any[]) => {
    await taskModel.create({ task_id: taskId, type: 'MOVE', status: TaskStatus.RUNNING, targetNode: 'N3', assignedRobotId: TB3, preferredRobotId: TB3 });
    const doc = await taskModel.findOne({ task_id: taskId });
    const id = String(doc._id);
    robotTasks.setActive(TB3, id);
    await exec.startPlan(id, plan);
    return id;
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

    exec   = app.get(TaskExecutionService);
    fms    = app.get(TaskRepositoryService);
    topo   = app.get(TopologyService);
    robots = app.get(RobotService);
    robotTasks = app.get(RobotTaskQueueService);
    ros    = app.get(RosService);
    taskModel = app.get(getModelToken(TaskHistory.name));

    app.get(TaskManagerService).setServer({ emit() {} } as any);

    await topo.createNode({ node_id: 'N2', map_id: 'm', type: NodeType.WAYPOINT, x: 2, y: 0, yaw: 0, isLocked: false });
    await topo.createNode({ node_id: 'N3', map_id: 'm', type: NodeType.WAYPOINT, x: 4, y: 0, yaw: 0, isLocked: false });
    await robots.autoRegister(TB3);

    // nav2 액션 / 서비스 응답을 테스트가 주입
    jest.spyOn(ros, 'sendActionGoal').mockImplementation((p: any, _fb: any, onResult: any) => {
      navGoals.push({ goal: p.goal, onResult }); return `g${navGoals.length}`;
    });
    jest.spyOn(ros, 'callService').mockImplementation((p: any, cb: any) => { svcCalls.push({ payload: p, cb }); });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await sleep(300);
    try { await app?.close(); } catch { /* 타이머/Mongo close 경쟁 — 무해 */ }
  });

  it('move→service→wait→topic→move 가 순차로 실행되고 완료된다', async () => {
    const nBase = navGoals.length, sBase = svcCalls.length;
    const plan = [
      moveStep('N2', 2),
      serviceStep(TB3, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 5, forward_speed: 0 }),
      waitStep(TB3, 150),
      topicStep(`/${TB3}/extra_cmd`, 'std_msgs/Bool', { data: true }),
      moveStep('N3', 4),
    ];
    const id = await startTask('CS1', plan);

    // 스텝0: move N2 액션
    await waitFor(() => navGoals.length >= nBase + 1, 6_000, 'move N2 goal');
    expect(navGoals[nBase].goal.pose.pose.position.x).toBeCloseTo(2, 1);
    navGoals[nBase].onResult({ goalId: 'g', actionName: '', result: {}, status: 3 }); // N2 도착

    // 스텝1: service 호출 (move 다음)
    await waitFor(() => svcCalls.length >= sBase + 1, 6_000, 'service call');
    expect(svcCalls[sBase].payload.serviceName).toBe(`/${TB3}/deploy`);
    expect(svcCalls[sBase].payload.request.forward_time).toBe(5);
    svcCalls[sBase].cb({ success: true, driven_time: 5, message: 'ok' }); // 응답 성공 → wait→topic 자동 진행

    // 스텝2(wait 150ms)·스텝3(topic) 자동 → 스텝4: move N3 액션
    await waitFor(() => navGoals.length >= nBase + 2, 6_000, 'move N3 goal');
    expect(navGoals[nBase + 1].goal.pose.pose.position.x).toBeCloseTo(4, 1);
    expect((await fms.getTask(id))?.status).not.toBe(TaskStatus.COMPLETED); // 아직 미완료

    navGoals[nBase + 1].onResult({ goalId: 'g', actionName: '', result: {}, status: 3 }); // N3 도착(마지막) → 완료
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 6_000, 'COMPLETED');
    expect((await robots.findById(TB3))?.lastNode).toBe('N3');
  });

  it('서비스 응답 success=false → 태스크 자동 FAILED', async () => {
    const nBase = navGoals.length, sBase = svcCalls.length;
    const plan = [moveStep('N2', 2), serviceStep(TB3, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 5 }), moveStep('N3', 4)];
    const id = await startTask('CS2', plan);

    await waitFor(() => navGoals.length >= nBase + 1, 6_000, 'move N2');
    navGoals[nBase].onResult({ goalId: 'g', actionName: '', result: {}, status: 3 });
    await waitFor(() => svcCalls.length >= sBase + 1, 6_000, 'service');
    svcCalls[sBase].cb({ success: false, message: '전개 모터 오류' }); // 서비스 실패 → 태스크 FAILED

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.FAILED, 6_000, 'FAILED');
    const failed = await fms.getTask(id);
    expect(failed?.errorMessage).toContain('서비스 실패');
    expect(navGoals.length).toBe(nBase + 1); // N3 액션은 안 나감(실패로 중단)
  });

  it('마지막 스텝이 비-이동(service)이어도 완료된다', async () => {
    const nBase = navGoals.length, sBase = svcCalls.length;
    const plan = [moveStep('N2', 2), serviceStep(TB3, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 3 })];
    const id = await startTask('CS3', plan);

    await waitFor(() => navGoals.length >= nBase + 1, 6_000, 'move N2');
    navGoals[nBase].onResult({ goalId: 'g', actionName: '', result: {}, status: 3 }); // N2 도착 → service
    await waitFor(() => svcCalls.length >= sBase + 1, 6_000, 'service');
    svcCalls[sBase].cb({ success: true, message: 'done' }); // 마지막 스텝 → 완료

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 6_000, 'COMPLETED');
    expect((await robots.findById(TB3))?.lastNode).toBe('N2'); // 마지막으로 도착한 노드
  });
});
