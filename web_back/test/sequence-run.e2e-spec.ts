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
import { TaskExecutionService, serviceStep, topicStep, waitStep } from '../src/fms/task-execution.service';
import { TaskPlannerService } from '../src/fms/task-planner.service';
import { RobotMonitorService } from '../src/fms/robot-monitor.service';
import { AutoDispatcherService } from '../src/fms/auto-dispatcher.service';
import { AutoChargerService } from '../src/fms/auto-charger.service';
import { AutoTaskService } from '../src/fms/auto-task.service';
import { CoreEventBus } from '../src/core-events/core-events.service';
import { TaskManagerService } from '../src/fms/task-manager.service';
import { CollisionAvoidanceService } from '../src/collision-avoidance/collision-avoidance.service';

import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';
import { TaskCatalogService } from '../src/task-catalog/task-catalog.service';

const MONGO = 'mongodb://127.0.0.1:27017/fms_seqrun_verify';
const BOT = 'TEST-BOT1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await pred()) return; await sleep(200); }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

describe('runSequence — 저장 시나리오 실행(조합 케이스): 경로계산 스텝 ↔ 커스텀 혼합 스텝 핸드오프', () => {
  let app: any;
  let tm: TaskManagerService;
  let fms: TaskRepositoryService;
  let topo: TopologyService;
  let robots: RobotService;
  let state: RobotStateService;
  let catalog: TaskCatalogService;
  let ros: RosService;
  let svcCalls: { payload: any; cb: (res: any) => void }[] = [];

  jest.setTimeout(180_000);

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
        TaskCatalogModule, // TaskCatalogService(정의/시퀀스) — runSequence가 사용
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

    tm      = app.get(TaskManagerService);
    fms     = app.get(TaskRepositoryService);
    topo    = app.get(TopologyService);
    robots  = app.get(RobotService);
    state   = app.get(RobotStateService);
    catalog = app.get(TaskCatalogService);
    ros     = app.get(RosService);

    tm.setServer({ emit() {} } as any);

    const mk = (id: string, x: number, y: number) => topo.createNode({ node_id: id, map_id: 'seqmap', type: NodeType.WAYPOINT, x, y, yaw: 0, isLocked: false });
    await mk('N1', 0, 0); await mk('N2', 2, 0); await mk('N3', 4, 0);
    const edge = (id: string, a: string, b: string) => topo.createEdge({ edge_id: id, map_id: 'seqmap', startNode: a, endNode: b, direction: EdgeDirection.BOTH_WAY, weight: 1, isLocked: false });
    await edge('E1', 'N1', 'N2'); await edge('E2', 'N2', 'N3');

    // 서비스 응답을 테스트가 주입 (rosbridge 없음)
    jest.spyOn(ros, 'callService').mockImplementation((p: any, cb: any) => { svcCalls.push({ payload: p, cb }); });

    // 가상 TEST-BOT 온라인 대기
    await waitFor(() => { const c = state.getCache(BOT); return !!c && Date.now() - c.lastSeen < 5000; }, 15_000, 'test-bot online');
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await sleep(300);
    try { await app?.close(); } catch { /* teardown race — 무해 */ }
  });

  it('저장된 시퀀스[경로계산 MOVE → 커스텀(service+wait+topic)]를 실행하면 순차 핸드오프로 모두 완료된다', async () => {
    const sBase = svcCalls.length;

    // ── 정의 2개 저장 ──
    const plainMove = await catalog.createTaskDef({ name: 'N3로 이동', type: TaskType.MOVE, targetNode: 'N3' });
    const custom = await catalog.createTaskDef({
      name: '전개 시퀀스', type: TaskType.PROCESS,                                    // 도착 후 현장 작업(이동 없음)
      steps: [
        serviceStep(BOT, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 5 }), // 서비스
        waitStep(BOT, 150),                                                          // 대기
        topicStep(`/${BOT}/extra_cmd`, 'std_msgs/Bool', { data: true }),             // 토픽
      ] as any,
    });

    // ── 시퀀스로 묶어 저장 (같은 로봇 순차 핸드오프) ──
    const seq = await catalog.createSequence({
      name: '이동→전개 시나리오',
      items: [
        { seq: 0, task: String(plainMove._id), robotId: BOT },
        { seq: 1, task: String(custom._id),    robotId: BOT },
      ],
    });

    // ── 실행 ──
    const tasks: any[] = await tm.runSequence(String(seq._id));
    expect(tasks.length).toBe(2);
    const id0 = String(tasks[0]._id), id1 = String(tasks[1]._id);
    expect(tasks[1].rosPlan.length).toBe(3); // 커스텀 스텝이 실행 레코드에 실림

    // 스텝0(경로계산 MOVE) — 가상봇이 N3 도착 → 완료 → advanceScenario가 스텝1 dispatch
    await waitFor(async () => (await fms.getTask(id0))?.status === TaskStatus.COMPLETED, 60_000, 'step0 COMPLETED');
    expect((await robots.findById(BOT))?.lastNode).toBe('N3');

    // 스텝1(커스텀): 핸드오프되어 service 호출됨 → 응답 주입 → wait→topic 자동 → 완료
    await waitFor(() => svcCalls.length >= sBase + 1, 30_000, 'custom service called');
    expect(svcCalls[sBase].payload.serviceName).toBe(`/${BOT}/deploy`);     // retarget으로 로봇 바인딩됨
    svcCalls[sBase].cb({ success: true, driven_time: 5, message: 'ok' });   // 성공 → wait→topic 자동 진행 → 완료

    // 스텝1 완료 → 시나리오 전체 완료
    await waitFor(async () => (await fms.getTask(id1))?.status === TaskStatus.COMPLETED, 30_000, 'step1 COMPLETED');
    expect((await fms.getTask(id0))?.status).toBe(TaskStatus.COMPLETED);
  });

  it('커스텀 스텝 서비스가 success=false면 해당 스텝 태스크가 FAILED 된다', async () => {
    const sBase = svcCalls.length;
    const failDef = await catalog.createTaskDef({
      name: '전개 실패', type: TaskType.PROCESS,
      steps: [
        serviceStep(BOT, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 5 }),
      ] as any,
    });
    const seq = await catalog.createSequence({ name: '실패 시나리오', items: [{ seq: 0, task: String(failDef._id), robotId: BOT }] });
    const tasks: any[] = await tm.runSequence(String(seq._id));
    const id = String(tasks[0]._id);

    await waitFor(() => svcCalls.length >= sBase + 1, 60_000, 'service called');
    svcCalls[sBase].cb({ success: false, message: '전개 모터 오류' }); // 서비스 실패 → 태스크 FAILED

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.FAILED, 30_000, 'FAILED');
    expect((await fms.getTask(id))?.errorMessage).toContain('서비스 실패');
  });

  it('단계의 로봇을 비우면(미지정) 추천 랭킹으로 자동 배정된다', async () => {
    const sBase = svcCalls.length;
    const def = await catalog.createTaskDef({
      name: '자동배정 전개', type: TaskType.PROCESS,
      steps: [serviceStep(BOT, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 1 })] as any,
    });
    // robotId 생략 — 미지정
    const seq = await catalog.createSequence({ name: '자동배정 시나리오', items: [{ seq: 0, task: String(def._id) }] });
    const tasks: any[] = await tm.runSequence(String(seq._id));

    expect(tasks.length).toBe(1);
    expect(tasks[0].preferredRobotId).toBeTruthy(); // 미지정 → 추천으로 온라인 로봇 자동 배정(null 아님)
    const assigned = tasks[0].preferredRobotId;

    // 자동 배정된 로봇으로 retarget 되어 service 호출됨 → 완료
    await waitFor(() => svcCalls.length >= sBase + 1, 30_000, 'auto service called');
    expect(svcCalls[sBase].payload.serviceName).toBe(`/${assigned}/deploy`); // 추천 로봇으로 바인딩
    svcCalls[sBase].cb({ success: true, message: 'ok' });
    await waitFor(async () => (await fms.getTask(String(tasks[0]._id)))?.status === TaskStatus.COMPLETED, 30_000, 'COMPLETED');
  });

  it('시퀀스 항목의 Task 정의가 삭제되면 runSequence가 명확히 실패한다', async () => {
    const def = await catalog.createTaskDef({ name: '임시', type: TaskType.MOVE, targetNode: 'N1' });
    const seq = await catalog.createSequence({ name: '깨진 시나리오', items: [{ seq: 0, task: String(def._id), robotId: BOT }] });
    await catalog.deleteTaskDef(String(def._id)); // 참조 정의 삭제 → populate null
    await expect(tm.runSequence(String(seq._id))).rejects.toThrow('정의 누락');
  });

  it('runTaskDef — 유형 없이 정의만 저장해 단일 태스크로 실행(시나리오 아님)', async () => {
    const sBase = svcCalls.length;
    const def = await catalog.createTaskDef({   // type 미지정 → 기본값(MOVE), UI는 유형을 안 보냄
      name: '단일 전개 테스트', preferredRobotId: BOT, priority: 1,
      steps: [serviceStep(BOT, 'deploy', 'turtlebot_state_msgs/srv/Deploy', { forward_time: 1 })] as any,
    });
    const task: any = await tm.runTaskDef(String(def._id)); // 단일 실행
    const id = String(task._id);
    expect(task.preferredRobotId).toBe(BOT);
    expect(task.priority).toBe(1);                          // 정의 우선순위가 실행에 반영
    expect(task.label).toBe('단일 전개 테스트');              // 정의 이름이 실행 레코드에 표시용으로 실림
    expect((await fms.getTask(id))?.scenarioId ?? null).toBeNull(); // 시나리오 아님

    await waitFor(() => svcCalls.length >= sBase + 1, 10_000, 'service');
    expect(svcCalls[sBase].payload.serviceName).toBe(`/${BOT}/deploy`);
    svcCalls[sBase].cb({ success: true });
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 10_000, 'COMPLETED');
  });

  it('로봇 ERROR 재등록 — 커스텀 태스크가 rosPlan·label 보존 후 다른 로봇으로 재실행된다', async () => {
    const monitor = app.get(RobotMonitorService);
    const taskStatus = app.get(TaskStatusService);
    const sBase = svcCalls.length;

    // 1) 커스텀 태스크 실행 (서비스 응답 대기 중 = RUNNING on BOT)
    const def = await catalog.createTaskDef({ name: '순찰테스트', preferredRobotId: BOT, steps: [serviceStep(BOT, 'deploy', 'pkg/srv/Deploy', {})] as any });
    const orig: any = await tm.runTaskDef(String(def._id));
    await waitFor(() => svcCalls.length >= sBase + 1, 10_000, 'orig svc');
    expect(svcCalls[sBase].payload.serviceName).toBe(`/${BOT}/deploy`);

    // 2) 로봇 ERROR → 진행 태스크 FAILED + 새 PENDING 재등록
    await monitor.releaseRobotTasks(BOT, '로봇 ERROR 테스트');
    expect((await fms.getTask(String(orig._id)))?.status).toBe(TaskStatus.FAILED);

    // 3) 재등록 태스크 — rosPlan·label 보존, 미배정
    const requeued: any = (await fms.list({ status: 'PENDING' })).find((t: any) => t.label === '순찰테스트');
    expect(requeued).toBeTruthy();
    expect(requeued.rosPlan.length).toBe(1);
    expect(requeued.preferredRobotId ?? null).toBeNull();

    // 4) 다른 로봇(TEST-BOT2)으로 재배차 → retarget 되어 그 로봇에서 실행
    const sBase2 = svcCalls.length;
    await taskStatus.prepareForDispatch(String(requeued._id), 'TEST-BOT2');
    await tm.dispatchTask(String(requeued._id));
    await waitFor(() => svcCalls.length >= sBase2 + 1, 10_000, 're-run svc');
    expect(svcCalls[sBase2].payload.serviceName).toBe('/TEST-BOT2/deploy'); // 새 로봇으로 재바인딩
    svcCalls[sBase2].cb({ success: true }); // 완료시켜 로봇 해제(다음 테스트 간섭 방지)
    await waitFor(async () => (await fms.getTask(String(requeued._id)))?.status === TaskStatus.COMPLETED, 10_000, 're-run done');
  });

  it('auto-dispatcher ON — 미배정 PENDING 커스텀 태스크를 로봇 우선순위 랭킹으로 즉시 자동 배차', async () => {
    const auto = app.get(AutoDispatcherService);
    const sBase = svcCalls.length;
    // 재등록과 동일한 모양: rosPlan 있는 미배정 PENDING (로봇 지정 없음)
    const created: any = await fms.createQueued({ label: '자동배차', type: TaskType.MOVE, rosPlan: [serviceStep(BOT, 'deploy', 'pkg/srv/Deploy', {})] as any });
    expect((await fms.getTask(String(created._id)))?.status).toBe(TaskStatus.PENDING);
    expect(created.preferredRobotId ?? null).toBeNull();

    auto.setAutoDispatch(true);
    await auto.runIfEnabled();   // 1회 자동 디스패치
    auto.setAutoDispatch(false);

    // 랭킹 최우선 가용 로봇에 자동 배정되어 그 로봇으로 service 호출됨
    await waitFor(() => svcCalls.length >= sBase + 1, 10_000, 'auto-dispatched svc');
    expect(svcCalls[sBase].payload.serviceName).toMatch(/^\/TEST-BOT\d\/deploy$/);
    expect((await fms.getTask(String(created._id)))?.status).toBe(TaskStatus.RUNNING);
    expect((await fms.getTask(String(created._id)))?.assignedRobotId).toMatch(/^TEST-BOT\d$/);
    svcCalls[sBase].cb({ success: true }); // 완료시켜 로봇 해제(다음 테스트 간섭 방지)
    await waitFor(async () => (await fms.getTask(String(created._id)))?.status === TaskStatus.COMPLETED, 10_000, 'auto done');
  });

  it('move 스텝의 {robot}·{target} 변수가 실행 시 실제 로봇·목적지로 해석된다', async () => {
    const def = await catalog.createTaskDef({
      name: '목표지점 이동', type: TaskType.MOVE, targetNode: 'N3', // 목적지는 실행 파라미터
      steps: [{
        kind: 'move', topicName: '/{robot}/goal_pose', messageType: 'geometry_msgs/PoseStamped',
        message: {}, awaitNodeId: '{target}', awaitKind: 'arrival', waitMs: 0,
      }] as any,
    });
    const seq = await catalog.createSequence({ name: '목표지점 시나리오', items: [{ seq: 0, task: String(def._id), robotId: BOT }] });
    const tasks: any[] = await tm.runSequence(String(seq._id));

    const t = await fms.getTask(String(tasks[0]._id));
    expect(t?.rosPlan[0].awaitNodeId).toBe('N3');                 // {target} → task.targetNode
    expect(t?.rosPlan[0].topicName).toBe(`/${BOT}/goal_pose`);    // {robot} → 실제 로봇
    expect((t?.rosPlan[0].message as any).pose.position.x).toBeCloseTo(4, 1); // N3 좌표로 goal_pose 채움
  });

  it('repeat=true 커스텀 태스크 — 한 사이클 완료 후 기존 반복 메커니즘으로 자동 재시작', async () => {
    const sBase = svcCalls.length;
    const def = await catalog.createTaskDef({ name: '반복순찰', preferredRobotId: BOT, repeat: true, steps: [serviceStep(BOT, 'deploy', 'pkg/srv/Deploy', {})] as any });
    const task: any = await tm.runTaskDef(String(def._id));
    const id = String(task._id);
    expect((await fms.getTask(id))?.repeat).toBe(true); // 반복 플래그 실행에 반영

    // 1회차 — service 호출 → 완료
    await waitFor(() => svcCalls.length >= sBase + 1, 10_000, 'cycle1 svc');
    svcCalls[sBase].cb({ success: true });

    // restartRepeatCycle이 자동 재시작 → 2회차 service 호출 (= 반복 동작 확인)
    await waitFor(() => svcCalls.length >= sBase + 2, 15_000, 'cycle2 svc (restart)');
    expect(svcCalls[sBase + 1].payload.serviceName).toBe(`/${BOT}/deploy`);
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.RUNNING, 5_000, 'running again');
    // 2회차는 미완료로 둠 → 추가 재시작 없이 멈춤(무한 루프 방지)
  });

  it('생성 조건(트리거) — ROS 신호가 맞으면 그 커스텀 태스크가 자동 생성(PENDING)된다', async () => {
    const autoTask = app.get(AutoTaskService);
    const def = await catalog.createTaskDef({
      name: '알람대응', preferredRobotId: BOT,
      triggerTopic: '/sensor/alarm', triggerField: 'level', triggerValue: 3, // /sensor/alarm 의 level==3 이면 생성
      steps: [serviceStep(BOT, 'deploy', 'pkg/srv/Deploy', {})] as any,
    });
    void def;
    autoTask.setEnabled(true);
    await autoTask.refreshIfEnabled(); // 트리거 캐시 로드

    // 비매칭(level 1) → 생성 안 됨
    ros.injectMessage({ topic: '/sensor/alarm', data: { level: 1 }, timestamp: Date.now() });
    await sleep(300);
    expect((await fms.list({ status: 'PENDING' })).filter((t: any) => t.label === '알람대응').length).toBe(0);

    // 매칭(level 3) → 1건 자동 생성(PENDING, rosPlan 보존)
    ros.injectMessage({ topic: '/sensor/alarm', data: { level: 3 }, timestamp: Date.now() });
    await waitFor(async () => (await fms.list({ status: 'PENDING' })).some((t: any) => t.label === '알람대응'), 5_000, 'auto-created');
    const created = (await fms.list({ status: 'PENDING' })).filter((t: any) => t.label === '알람대응');
    expect(created.length).toBe(1);
    expect(created[0].rosPlan.length).toBe(1);

    autoTask.setEnabled(false);
  });
});
