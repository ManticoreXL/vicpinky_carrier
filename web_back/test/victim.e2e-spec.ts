import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
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
import { VictimService } from '../src/victim/victim.service';

const MONGO = 'mongodb://127.0.0.1:27017/fms_victim_verify';
const BOT   = 'TEST-BOT1'; // 백엔드 내장 가상 테스트봇(구호 이동 수행)
const SCOUT = 'tb3_01';    // 정찰봇 — /victim/confirmed 좌표의 맵 기준(VictimService 기본값)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(250);
  }
  throw new Error(`timeout(${timeoutMs}ms): ${label}`);
}

// 조난자 임시노드 흐름: /victim/confirmed → VICTIM 노드 + STATION 엣지 → 임시노드로 이동 → 노드 삭제 cascade
describe('Victim 임시노드 (STATION 연결 + 이동 + cascade) — virtual test-bot + MongoDB', () => {
  let app: any;
  let tm:     TaskManagerService;
  let fms:    TaskRepositoryService;
  let topo:   TopologyService;
  let robots: RobotService;
  let state:  RobotStateService;
  let ros:    RosService;

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
        VictimService, // ← 테스트 대상
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

    // 토폴로지(verifymap):
    //   N1(0,0) WAYPOINT  — 테스트봇 시작점
    //   S1(2,0) STATION   — victim(2.5,0)에서 0.50m
    //   C1(2.3,0.2) CHARGER — victim에서 0.28m (S1보다 더 가깝다 → STATION-only 필터 검증용)
    // 엣지 N1-S1 만 둔다(테스트봇이 S1 경유 → victim 도달).
    //   ISO(2.4,0.1) STATION — victim에 가장 가깝지만 엣지 없는 "고립 STATION"(실맵의 '칠판' 재현)
    await topo.createNode({ node_id: 'N1',  map_id: 'verifymap', type: NodeType.WAYPOINT, x: 0,   y: 0,   yaw: 0, isLocked: false });
    await topo.createNode({ node_id: 'S1',  map_id: 'verifymap', type: NodeType.STATION,  x: 2,   y: 0,   yaw: 0, isLocked: false });
    await topo.createNode({ node_id: 'C1',  map_id: 'verifymap', type: NodeType.CHARGER,  x: 2.3, y: 0.2, yaw: 0, isLocked: false });
    await topo.createNode({ node_id: 'ISO', map_id: 'verifymap', type: NodeType.STATION,  x: 2.4, y: 0.1, yaw: 0, isLocked: false }); // 엣지 없음 = 고립
    await topo.createEdge({ edge_id: 'E1', map_id: 'verifymap', startNode: 'N1', endNode: 'S1', direction: EdgeDirection.BOTH_WAY, weight: 2, isLocked: false });
    // 고아 엣지 — ISO를 "삭제된 노드"에 잇는다(실재 X). 옛 버그: 이걸 비-VICTIM 연결로 오인해 ISO를 후보로 잡음.
    await topo.createEdge({ edge_id: 'EORPH', map_id: 'verifymap', startNode: 'ISO', endNode: 'GHOST_DELETED', direction: EdgeDirection.BOTH_WAY, weight: 1, isLocked: false });

    // 정찰봇(tb3_03)을 verifymap에 둔다 → VictimService가 이 맵에 VICTIM 노드를 만든다.
    await robots.autoRegister(SCOUT);
    await robots.setInitialPose(SCOUT, 'verifymap', 2.5, 0, 0, null);
  });

  afterAll(async () => { await app?.close(); });

  let victimNodeId = '';
  let victimEdgeId = '';

  it('test-bot이 온라인이 된다', async () => {
    await waitFor(() => {
      const c = state.getCache(BOT);
      return !!c && Date.now() - c.lastSeen < 5000;
    }, 15_000, 'test-bot online');
    expect(state.getCache(BOT)!.posX).toBeCloseTo(0, 1);
  });

  it('/victim/confirmed → VICTIM 노드 생성 + STATION(S1)에만 엣지(더 가까운 CHARGER C1 아님)', async () => {
    // rosbridge 수신과 동일한 경로로 /victim/confirmed 주입 (가상 시뮬레이터 메커니즘)
    ros.injectMessage({
      topic: '/victim/confirmed',
      data: { pose: { position: { x: 2.5, y: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      timestamp: Date.now(),
    });

    await waitFor(async () => (await topo.findNodesByType('verifymap', NodeType.VICTIM)).length > 0, 8_000, 'victim node 생성');
    const victims = await topo.findNodesByType('verifymap', NodeType.VICTIM);
    expect(victims).toHaveLength(1);
    victimNodeId = victims[0].node_id;
    expect(victims[0].x).toBeCloseTo(2.5, 1);

    // 엣지는 "그래프에 연결된 STATION"(S1)에만 — 더 가까운 CHARGER(C1)·고립 STATION(ISO)은 제외
    const edges = await topo.findAllEdges('verifymap');
    const vEdge = edges.find((e) => e.startNode === victimNodeId || e.endNode === victimNodeId);
    expect(vEdge).toBeDefined();
    victimEdgeId = vEdge!.edge_id;
    const other = vEdge!.startNode === victimNodeId ? vEdge!.endNode : vEdge!.startNode;
    expect(other).toBe('S1');      // 연결된 STATION
    expect(other).not.toBe('C1');  // CHARGER 아님
    expect(other).not.toBe('ISO'); // 고립 STATION 아님 — 고아 엣지(ISO↔GHOST)에 속지 않음(더 가까워도 제외)
  });

  it('이동: TEST-BOT1을 VICTIM 임시노드로 보내기 → 주행 → 완료', async () => {
    // "이동" 태스크 목적지로 임시노드 지정(프론트 드롭다운에서 고르는 것과 동일하게 targetNode=victim)
    const task = await tm.enqueue({ type: TaskType.MOVE, targetNode: victimNodeId, preferredRobotId: BOT });
    const id = String((task as any)._id);
    const res = await tm.dispatchTask(id);
    expect(res.ok).toBe(true);

    await waitFor(async () => (await fms.getTask(id))?.status === TaskStatus.COMPLETED, 40_000, '임시노드 이동 COMPLETED');
    const done = await fms.getTask(id);
    expect(done?.status).toBe(TaskStatus.COMPLETED);
    expect(done?.fullPath).toContain('S1');                 // N1→S1→victim 경로(STATION 경유)
    expect((await robots.findById(BOT))?.lastNode).toBe(victimNodeId); // 임시노드 도착
  });

  it('자동: AUTO DISPATCHER ON → victim 확정 시 VICTIM 노드로 향하는 구호(PROCESS) 태스크 자동 생성', async () => {
    const taskModel: any = app.get(getModelToken(TaskHistory.name));
    const before = (await topo.findNodesByType('verifymap', NodeType.VICTIM)).map((n) => n.node_id);

    tm.setAutoDispatch(true); // 자동 디스패처 ON → VictimService가 자동 구호 태스크 생성
    ros.injectMessage({
      topic: '/victim/confirmed',
      data: { pose: { position: { x: 1.0, y: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      timestamp: Date.now(),
    });

    // 새 VICTIM 노드(victim#2) 생성 대기
    await waitFor(async () => (await topo.findNodesByType('verifymap', NodeType.VICTIM)).some((n) => !before.includes(n.node_id)), 8_000, 'victim#2 node');
    const v2 = (await topo.findNodesByType('verifymap', NodeType.VICTIM)).find((n) => !before.includes(n.node_id))!;

    // 그 VICTIM 노드를 "정확히" 목적지로 하는 구호(PROCESS) 태스크가 자동 생성됨 (nearest STATION 아님)
    await waitFor(async () => !!(await taskModel.findOne({ type: TaskType.PROCESS, targetNode: v2.node_id })), 8_000, 'auto PROCESS task → victim node');
    const autoTask = await taskModel.findOne({ type: TaskType.PROCESS, targetNode: v2.node_id });
    expect(autoTask).toBeTruthy();
    expect(autoTask.targetNode).toBe(v2.node_id);

    tm.setAutoDispatch(false); // 이후 테스트 간섭 방지
  });

  it('고아 엣지 스윕: 삭제 노드를 참조하는 엣지는 onModuleInit 에서 제거된다', async () => {
    await topo.createEdge({ edge_id: 'EGHOST', map_id: 'verifymap', startNode: 'S1', endNode: 'NO_SUCH_NODE', direction: EdgeDirection.BOTH_WAY, weight: 1, isLocked: false });
    await topo.onModuleInit(); // 마이그레이션 + 고아 엣지 정리
    const edges = await topo.findAllEdges('verifymap');
    expect(edges.find((e) => e.edge_id === 'EGHOST')).toBeUndefined(); // 고아 제거
    expect(edges.find((e) => e.edge_id === 'EORPH')).toBeUndefined();  // beforeAll 고아도 제거
    expect(edges.find((e) => e.edge_id === 'E1')).toBeDefined();        // 실제 엣지는 유지
  });

  it('cascade: VICTIM 노드 삭제 → 연결 엣지도 함께 삭제된다', async () => {
    await topo.removeNode(victimNodeId);
    expect(await topo.findNodeById(victimNodeId)).toBeNull();

    const edges = await topo.findAllEdges('verifymap');
    expect(edges.find((e) => e.edge_id === victimEdgeId)).toBeUndefined();           // 그 엣지 사라짐
    expect(edges.some((e) => e.startNode === victimNodeId || e.endNode === victimNodeId)).toBe(false); // 고아 엣지 없음
  });
});
