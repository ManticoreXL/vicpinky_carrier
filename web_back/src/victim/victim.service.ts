import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros/ros.service';
import type { RosMessage } from '../ros/ros.types';
import { RobotService } from '../robot/robot.service';
import { TopologyService } from '../topology/topology.service';
import { NodeType } from '../topology/node.schema';
import { EdgeDirection } from '../topology/edge.schema';
import { TaskManagerService } from '../fms/task-manager.service';
import { TaskType } from '../fms/task.schema';

// 조난자 신호를 쏘는 정찰 로봇 (확정 좌표는 이 로봇의 맵 프레임). 정찰=tb3_01 단독 운용.
const SCOUT_ROBOT_ID = process.env.VICTIM_SCOUT_ROBOT ?? 'tb3_01';

/**
 * 조난자(victim) — 사람 확정(/victim/confirmed, map 프레임 PoseStamped) 수신 시:
 *   1) 정찰 로봇의 현재 맵에 임시 VICTIM 노드를 등록한다.
 *   2) 그 맵의 가장 가까운 STATION 노드와 엣지로 이어, 로봇이 노드-투-노드(A*)로 도달할 수 있게 한다.
 *   3) AUTO DISPATCHER ON이면 이 VICTIM 노드를 목적지로 하는 구호(PROCESS) 태스크를 자동 생성한다(자동 경로).
 * 구호 이동 두 경로 공존 — (자동) 위 3) + (수동) 프론트 "이동" 목적지 목록의 VICTIM 노드 선택.
 * 노드 id를 여기서 바로 알기에 자동/수동 둘 다 "정확한 VICTIM 노드"를 목적지로 한다(독립 구독 race 없음).
 * 프론트는 같은 /victim/confirmed ros_message를 받아 토폴로지를 재조회한다(별도 소켓 broadcast 없음).
 */
@Injectable()
export class VictimService implements OnModuleInit {
  private readonly logger = new Logger(VictimService.name);

  constructor(
    private readonly rosService:  RosService,
    private readonly robots:      RobotService,
    private readonly topology:    TopologyService,
    private readonly taskManager: TaskManagerService,
  ) {}

  onModuleInit(): void {
    this.rosService.onMessage((msg) => {
      if (msg.topic === '/victim/confirmed') {
        void this.onConfirmed(msg).catch((e) => this.logger.error('[victim] 확정 처리 오류', e));
      }
    });
  }

  private async onConfirmed(msg: RosMessage): Promise<void> {
    const pos = (msg.data as { pose?: { position?: { x?: number; y?: number } } })?.pose?.position;
    if (pos?.x == null || pos?.y == null) { this.logger.warn('[victim] 좌표 없는 확정 신호 — 무시'); return; }

    // 맵 = 정찰 로봇의 현재 맵(location)
    const scout = await this.robots.findById(SCOUT_ROBOT_ID);
    const mapId = scout?.location;
    if (!mapId) { this.logger.warn(`[victim] ${SCOUT_ROBOT_ID} 맵(location) 미상 — 노드 생성 생략`); return; }

    // 1) 임시 VICTIM 노드 등록
    const nodeId = `victim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await this.topology.createNode({ node_id: nodeId, map_id: mapId, type: NodeType.VICTIM, x: pos.x, y: pos.y, yaw: 0 });

    // 2) 가장 가까운 STATION 노드와만 엣지 연결 → 기존 A*가 노드-투-노드 경로를 자동 생성.
    //    STATION만 허용: 충전소(CHARGER)·웨이포인트(WAYPOINT) 등에는 잇지 않는다(충전소 잘못 연결 방지).
    const nearest = await this.nearestStation(mapId, pos.x, pos.y);
    if (nearest) {
      const d = Math.hypot(nearest.x - pos.x, nearest.y - pos.y);
      await this.topology.createEdge({
        edge_id: `victim_e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        map_id: mapId, startNode: nodeId, endNode: nearest.node_id,
        direction: EdgeDirection.BOTH_WAY, weight: Math.max(0.01, d),
      });
      this.logger.log(`[victim] ${nodeId} (${pos.x.toFixed(2)},${pos.y.toFixed(2)})@${mapId} → 최근접 ${nearest.node_id}(${d.toFixed(2)}m) 엣지 연결`);

      // 3) 자동 경로 — AUTO DISPATCHER ON이면 이 VICTIM 노드를 목적지로 하는 구호(PROCESS) 태스크를 자동 생성.
      //    미배정 PENDING → AUTO DISPATCHER가 가용 구호 로봇(비-omx)에 배정. 엣지가 있어야 경로탐색이 되므로 이 블록 안에서만.
      //    (수동 경로는 프론트 "이동" 드롭다운에서 이 VICTIM 노드 선택 — 둘 다 같은 노드를 목적지로 공존)
      if (this.taskManager.isAutoDispatch()) {
        const task = await this.taskManager.enqueue({ type: TaskType.PROCESS, targetNode: nodeId, priority: 2 });
        this.logger.log(`[victim] ${nodeId} 구호 태스크 자동 생성(${(task as { task_id?: string }).task_id ?? ''}) — AUTO DISPATCHER 배정 대기`);
      }
    } else {
      this.logger.warn(`[victim] ${nodeId} 등록 — 맵 ${mapId}에 연결할 STATION 노드 없음(엣지 생략)`);
    }
  }

  /**
   * victim을 붙일 가장 가까운 STATION 노드.
   *  - STATION 타입만 (CHARGER/WAYPOINT/VICTIM 제외)
   *  - 그리고 "네비게이션 그래프에 연결된" STATION만 — 즉 비-VICTIM 노드와 엣지로 이어진 노드.
   *    (엣지 없는 고립 라벨 STATION(예: '칠판')에 붙이면 로봇이 도달할 경로가 없어 '경로 없음'이 된다)
   *  없으면 null.
   */
  private async nearestStation(mapId: string, x: number, y: number): Promise<{ node_id: string; x: number; y: number } | null> {
    const [nodes, edges] = await Promise.all([
      this.topology.findAllNodes(mapId),
      this.topology.findAllEdges(mapId),
    ]);
    const typeOf = new Map(nodes.map((n) => [n.node_id, n.type]));
    // 그래프에 속한 노드 = "실재하는 비-VICTIM 노드끼리" 이어진 엣지의 양 끝.
    // ⚠ 삭제 노드 참조 고아 엣지(type=undefined)·victim 전용 연결은 제외 — 고아 엣지에 속아
    //   고립 STATION(예: 칠판)을 '연결됨'으로 오인하면 도달 불가 노드에 victim을 붙이게 된다.
    const inGraph = new Set<string>();
    for (const e of edges) {
      const st = typeOf.get(e.startNode);
      const et = typeOf.get(e.endNode);
      if (st != null && st !== NodeType.VICTIM && et != null && et !== NodeType.VICTIM) {
        inGraph.add(e.startNode);
        inGraph.add(e.endNode);
      }
    }
    const stations = nodes.filter((n) => n.type === NodeType.STATION && inGraph.has(n.node_id));
    let best: { node_id: string; x: number; y: number } | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of stations) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = { node_id: n.node_id, x: n.x, y: n.y }; }
    }
    return best;
  }
}
