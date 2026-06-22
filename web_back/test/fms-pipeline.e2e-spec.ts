import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { Robot, RobotSchema } from '../src/robot/robot.schema';
import { Node, NodeSchema, NodeType } from '../src/topology/node.schema';
import { Edge, EdgeSchema, EdgeDirection } from '../src/topology/edge.schema';
import { Task, TaskSchema, TaskType, TaskStatus } from '../src/fms/task.schema';

import { RobotService } from '../src/robot/robot.service';
import { TopologyService } from '../src/topology/topology.service';
import { PathfindingService } from '../src/pathfinding/pathfinding.service';
import { NodeOccupancyService } from '../src/node-occupancy/node-occupancy.service';
import { CollisionAvoidanceService } from '../src/collision-avoidance/collision-avoidance.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { RosService } from '../src/ros/ros.service';
import { VirtualRobotService } from '../src/ros/virtual-robot/virtual-robot.service';
import { DomainBridgeService } from '../src/ros/domain-bridge/domain-bridge.service';

import { FmsService } from '../src/fms/fms.service';
import { TaskManagerEventsService } from '../src/fms-events/task-manager-events.service';
import { RobotStateService } from '../src/fms-state/robot-state.service';
import { RobotTaskQueueService } from '../src/fms-state/robot-task-queue.service';
import { RotationStateService } from '../src/fms-state/rotation-state.service';
import { GlobalTaskQueueService } from '../src/fms/queue/global-task-queue.service';
import { NavGoalService } from '../src/fms/navigation/nav-goal.service';
import { NodeLockService } from '../src/fms/node-lock/node-lock.service';
import { NavRecoveryService } from '../src/fms/navigation/nav-recovery.service';
import { NavigationService } from '../src/fms/navigation/navigation.service';
import { DispatchService } from '../src/fms/dispatch/dispatch.service';
import { SupplyTaskHandler } from '../src/fms/dispatch/task-handlers/supply-task.handler';
import { NavigationTaskHandler } from '../src/fms/dispatch/task-handlers/navigation-task.handler';
import { FallDetectionService } from '../src/fms/monitor/fall-detection.service';
import { RobotTelemetryService } from '../src/fms/monitor/robot-telemetry.service';
import { RobotMonitorService } from '../src/fms/monitor/robot-monitor.service';
import { TaskManagerService } from '../src/fms/task-manager.service';

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

describe('FMS pipeline (virtual test-bot + MongoDB)', () => {
  let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> extends never ? never : any;
  let tm: TaskManagerService;
  let fms: FmsService;
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
          { name: Task.name,  schema: TaskSchema  },
        ]),
      ],
      providers: [
        // fleet
        RobotService, TopologyService, PathfindingService,
        NodeOccupancyService, CollisionAvoidanceService, TelemetryService,
        // ros (실제 RosService + 내장 가상로봇 시뮬레이터)
        RosService, VirtualRobotService,
        { provide: DomainBridgeService, useValue: { getCapabilities: () => null } },
        // fms (리팩터링된 분리 서비스 전부)
        FmsService, TaskManagerEventsService, RobotStateService, RobotTaskQueueService,
        RotationStateService, GlobalTaskQueueService, NavGoalService, NodeLockService,
        NavRecoveryService, NavigationService, DispatchService, SupplyTaskHandler,
        NavigationTaskHandler, FallDetectionService, RobotTelemetryService,
        RobotMonitorService, TaskManagerService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit 전부 실행 (가상로봇 시작 + tick 루프 + telemetry 구독)

    const conn = app.get<Connection>(getConnectionToken());
    await conn.dropDatabase(); // 깨끗한 상태에서 시작

    tm     = app.get(TaskManagerService);
    fms    = app.get(FmsService);
    topo   = app.get(TopologyService);
    robots = app.get(RobotService);
    state  = app.get(RobotStateService);

    // 소켓 서버가 없으면 dispatch가 멈추므로 no-op 서버 주입
    tm.setServer({ emit() {} } as any);

    // 토폴로지 시드 (verifymap):
    //   직선 경로:  N1(0,0) —E1— N2(2,0) —E2— N3(4,0)    (가중치 1, 기본 선택)
    //   우회 경로:  N1 —E3— N4(2,2) —E4— N3              (가중치 3, N2 잠금 시 사용)
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
    const c = state.getCache(BOT)!;
    expect(c.posX).toBeCloseTo(0, 1);
  });

  it('경로탐색→배차→주행→완료 (N1→N3)', async () => {
    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: BOT });
    const id = String((task as any)._id);

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, 'task COMPLETED');

    const done = await fms.getTask(id);
    expect(done?.status).toBe(TaskStatus.COMPLETED);
    expect(done?.fullPath).toEqual(['N2', 'N3']); // N1은 출발지라 큐에서 제외
    const robot = await robots.findById(BOT);
    expect(robot?.location).toBe('N3');
  });

  it('로봇별 큐: 작업 중 들어온 2번째 태스크는 큐 적재 후 순차 실행', async () => {
    // 로봇이 N3에 IDLE 상태. A=N1, B=N3 를 연속 투입 → A 즉시 배정, B는 per-robot 큐로.
    const a = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N1', preferredRobotId: BOT });
    const b = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: BOT });
    const aId = String((a as any)._id), bId = String((b as any)._id);

    await waitFor(async () => (await fms.getTask(aId))?.status === TaskStatus.COMPLETED, 40_000, 'A COMPLETED');
    await waitFor(async () => (await fms.getTask(bId))?.status === TaskStatus.COMPLETED, 40_000, 'B COMPLETED');

    const A = await fms.getTask(aId), B = await fms.getTask(bId);
    expect(A?.status).toBe(TaskStatus.COMPLETED);
    expect(B?.status).toBe(TaskStatus.COMPLETED);
    // B는 A가 끝난 뒤에 비로소 시작됐어야 한다 (병렬 아님 = 큐잉 증거)
    expect(new Date(B!.startedAt as any).getTime()).toBeGreaterThanOrEqual(new Date(A!.completedAt as any).getTime() - 500);
  });

  it('노드 잠금 → 활성 로봇 우회 재경로 (N2 잠그면 N4 우회)', async () => {
    // 직전 테스트로 로봇은 N3에 있음. N3→N1 은 기본적으로 직선(N2) 경로로 배차된다.
    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: 'N1', preferredRobotId: BOT });
    const id = String((task as any)._id);

    // 배차되어 pathQueue가 N2(직선)를 포함할 때까지 대기 (로봇이 아직 N2 도달 전)
    await waitFor(async () => {
      const t = await fms.getTask(id);
      return !!t && (t.pathQueue ?? []).includes('N2');
    }, 20_000, 'assigned via N2');

    const before = await fms.getTask(id);
    expect(before?.pathQueue).toContain('N2'); // 잠그기 전: 직선 경로

    // N2 잠금 → NodeLockService가 경유 중인 로봇을 우회시켜야 함 (소켓 node_lock과 동일 경로)
    await tm.lockNode('N2', true);

    // 재경로 확인: 경로가 우회(N4)로 바뀌고 N2는 빠진다
    await waitFor(async () => {
      const t = await fms.getTask(id);
      const q = t?.pathQueue ?? [];
      return q.includes('N4') && !q.includes('N2');
    }, 20_000, 'rerouted via N4');

    const after = await fms.getTask(id);
    expect(after?.pathQueue).toContain('N4'); // 우회 경로로 전환
    expect(after?.pathQueue).not.toContain('N2');

    // 우회 경로로 끝까지 도착
    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, 'rerouted task COMPLETED');
    expect((await robots.findById(BOT))?.location).toBe('N1');

    await tm.lockNode('N2', false); // 정리
  });
});
