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
import { TaskExecutionService, serviceStep, signalWaitStep, actionStep } from '../src/fms/task-execution.service';
import { TaskPlannerService } from '../src/fms/task-planner.service';
import { RobotMonitorService } from '../src/fms/robot-monitor.service';
import { AutoDispatcherService } from '../src/fms/auto-dispatcher.service';
import { AutoChargerService } from '../src/fms/auto-charger.service';
import { AutoTaskService } from '../src/fms/auto-task.service';
import { CoreEventBus } from '../src/core-events/core-events.service';
import { TaskManagerService } from '../src/fms/task-manager.service';
import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';

const MONGO = 'mongodb://127.0.0.1:27017/fms_signal_verify';
const TB3 = 'tb3_01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await pred()) return; await sleep(100); }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

describe('신호 기반 완료(awaitKind=signal) — 게이트 / 태스크 성공', () => {
  let app: any;
  let exec: TaskExecutionService;
  let fms: TaskRepositoryService;
  let robots: RobotService;
  let robotTasks: RobotTaskQueueService;
  let ros: RosService;
  let taskModel: any;
  let svcCalls: { payload: any; cb: (res: any) => void }[] = [];
  let actGoals: { payload: any; onResult: (r: any) => void }[] = [];

  jest.setTimeout(60_000);

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
        TaskManagerService, CoreEventBus,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    const conn = app.get(getConnectionToken()) as Connection;
    await conn.dropDatabase();

    exec = app.get(TaskExecutionService);
    fms = app.get(TaskRepositoryService);
    robots = app.get(RobotService);
    robotTasks = app.get(RobotTaskQueueService);
    ros = app.get(RosService);
    taskModel = app.get(getModelToken(TaskHistory.name));
    app.get(TaskManagerService).setServer({ emit() {} } as any);

    await app.get(TopologyService).createNode({ node_id: 'N2', map_id: 'm', type: NodeType.WAYPOINT, x: 2, y: 0, yaw: 0, isLocked: false });
    await robots.autoRegister(TB3);
    await robots.updateNode(TB3, 'N2'); // completeGeneric 기준 노드

    jest.spyOn(ros, 'callService').mockImplementation((p: any, cb: any) => { svcCalls.push({ payload: p, cb }); });
    jest.spyOn(ros, 'sendActionGoal').mockImplementation((p: any, _fb: any, onResult: any) => { actGoals.push({ payload: p, onResult }); return `a${actGoals.length}`; });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await sleep(300);
    try { await app?.close(); } catch { /* teardown race */ }
  });

  it('마지막 스텝이 신호 대기면, 그 신호가 와야 태스크 성공(중간 비매칭 신호는 무시)', async () => {
    const sBase = svcCalls.length;
    const plan = [
      serviceStep(TB3, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 1 }),
      signalWaitStep(TB3, `/${TB3}/done`, 'data', true), // /tb3_01/done 의 data==true 면 완료
    ];
    const id = await startTask('SIG1', plan);

    await waitFor(() => svcCalls.length >= sBase + 1, 5_000, 'service called');
    svcCalls[sBase].cb({ success: true }); // service 성공 → 신호 대기로 진행

    await sleep(300);
    expect((await fms.getTask(id))?.status).toBe(TaskStatus.RUNNING); // 아직 신호 안 옴

    ros.injectMessage({ topic: `/${TB3}/done`, data: { data: false }, timestamp: Date.now() }); // 비매칭
    await sleep(300);
    expect((await fms.getTask(id))?.status).toBe(TaskStatus.RUNNING); // false → 무시

    ros.injectMessage({ topic: `/${TB3}/wrong`, data: { data: true }, timestamp: Date.now() }); // 다른 토픽
    await sleep(200);
    expect((await fms.getTask(id))?.status).toBe(TaskStatus.RUNNING);

    ros.injectMessage({ topic: `/${TB3}/done`, data: { data: true }, timestamp: Date.now() }); // 매칭 → 성공
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 5_000, 'COMPLETED');
  });

  it('중간 스텝이 신호 대기면, 신호가 와야 다음 스텝이 실행된다(게이트)', async () => {
    const sBase = svcCalls.length;
    const plan = [
      signalWaitStep(TB3, '/mission/go'), // 필드 없음 → 메시지 수신만으로 완료
      serviceStep(TB3, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 1 }),
    ];
    const id = await startTask('SIG2', plan);

    await sleep(400);
    expect(svcCalls.length).toBe(sBase); // 신호 전 — 다음(service) 미실행
    expect((await fms.getTask(id))?.status).toBe(TaskStatus.RUNNING);

    ros.injectMessage({ topic: '/mission/go', data: {}, timestamp: Date.now() }); // 게이트 열림
    await waitFor(() => svcCalls.length >= sBase + 1, 5_000, 'gate opened → service'); // 다음 스텝 실행됨
    svcCalls[sBase].cb({ success: true });
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 5_000, 'COMPLETED');
  });

  it('서비스 결과값 조건 — 응답 필드가 기대값과 일치하면 완료, 아니면 FAILED', async () => {
    // 일치
    const s1 = svcCalls.length;
    const okId = await startTask('SVC_OK', [serviceStep(TB3, 'check', 'pkg/srv/Check', {}, 'code', 0)]);
    await waitFor(() => svcCalls.length >= s1 + 1, 5_000, 'svc1');
    svcCalls[s1].cb({ code: 0, success: true }); // code==0 → 완료
    await waitFor(async () => (await fms.getTask(okId))?.status === TaskStatus.COMPLETED, 5_000, 'svc COMPLETED');

    // 불일치 → FAILED
    const s2 = svcCalls.length;
    const ngId = await startTask('SVC_NG', [serviceStep(TB3, 'check', 'pkg/srv/Check', {}, 'code', 0)]);
    await waitFor(() => svcCalls.length >= s2 + 1, 5_000, 'svc2');
    svcCalls[s2].cb({ code: 7, success: true }); // code!=0 → 결과 불일치
    await waitFor(async () => (await fms.getTask(ngId))?.status === TaskStatus.FAILED, 5_000, 'svc FAILED');
    expect((await fms.getTask(ngId))?.errorMessage).toContain('결과 불일치');
  });

  it('액션 결과값 — result 필드 매칭/SUCCEEDED면 완료, ABORTED·불일치면 FAILED', async () => {
    // 성공: status=3 + result.result_code==0
    const a1 = actGoals.length;
    const okId = await startTask('ACT_OK', [actionStep(TB3, 'dock', 'pkg/action/Dock', { slot: 1 }, 'result_code', 0)]);
    await waitFor(() => actGoals.length >= a1 + 1, 5_000, 'act1');
    expect(actGoals[a1].payload.actionName).toBe(`/${TB3}/dock`);
    actGoals[a1].onResult({ goalId: 'a', actionName: '', result: { result_code: 0 }, status: 3 });
    await waitFor(async () => (await fms.getTask(okId))?.status === TaskStatus.COMPLETED, 5_000, 'act COMPLETED');

    // ABORTED → FAILED
    const a2 = actGoals.length;
    const abId = await startTask('ACT_ABORT', [actionStep(TB3, 'dock', 'pkg/action/Dock', {}, 'result_code', 0)]);
    await waitFor(() => actGoals.length >= a2 + 1, 5_000, 'act2');
    actGoals[a2].onResult({ goalId: 'a', actionName: '', result: {}, status: 4 });
    await waitFor(async () => (await fms.getTask(abId))?.status === TaskStatus.FAILED, 5_000, 'act ABORT FAILED');

    // 결과 불일치 → FAILED
    const a3 = actGoals.length;
    const mmId = await startTask('ACT_MM', [actionStep(TB3, 'dock', 'pkg/action/Dock', {}, 'result_code', 0)]);
    await waitFor(() => actGoals.length >= a3 + 1, 5_000, 'act3');
    actGoals[a3].onResult({ goalId: 'a', actionName: '', result: { result_code: 9 }, status: 3 });
    await waitFor(async () => (await fms.getTask(mmId))?.status === TaskStatus.FAILED, 5_000, 'act MM FAILED');
    expect((await fms.getTask(mmId))?.errorMessage).toContain('결과 불일치');
  });
});
