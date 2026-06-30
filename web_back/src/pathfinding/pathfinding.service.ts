import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Node, NodeDocument, NodeType } from '../topology/node.schema';
import { Edge, EdgeDocument } from '../topology/edge.schema';

// 이 값 이하(0 또는 음수)인 weight는 비활성/차단 간선으로 간주하여 제외.
// (표준 다익스트라는 양수 비용을 요구 — 0.01 같은 작은 양수는 정상적인 저비용 간선이다)
const MIN_WEIGHT = 0;

// 노드와 노드 사이 거리(고정) — A* 경로 홉 수 × 이 값 = 거리(m).
const NODE_HOP_DIST = 0.1;

/**
 * 경로 탐색 전담 서비스.
 *
 * 노드/엣지 토폴로지(TopologyService)의 CRUD와 분리하여, "출발→도착 최단경로"와
 * "좌표/노드 기준 최근접 탐색"만 책임진다.
 *
 * 정책:
 *   - isLocked=true 엣지/노드 → 완전 제외 (출발·도착 노드 자신은 예외)
 *   - 점유(occupiedNodes) 노드 → 경유 제외 (출발·도착 노드 자신은 예외)
 *   - weight <= 0 → 비활성/차단 간선으로 제외
 *   - CHARGER 노드는 출발지가 아닌 한 경유 금지
 *   - 비용 = weight: 표준 다익스트라(가중치 낮을수록 우선 선택)
 */
@Injectable()
export class PathfindingService {
  private readonly logger = new Logger(PathfindingService.name);

  constructor(
    @InjectModel(Node.name) private readonly nodeModel: Model<NodeDocument>,
    @InjectModel(Edge.name) private readonly edgeModel: Model<EdgeDocument>,
  ) {}

  private async findLockedNodeIds(map_id: string): Promise<Set<string>> {
    const locked = await this.nodeModel.find({ map_id, isLocked: true }).lean().exec();
    return new Set(locked.map((n) => n.node_id));
  }

  // ── 최단 경로 (다익스트라) ─────────────────────────────────────────────────

  async findPath(
    startNodeId: string,
    endNodeId: string,
    map_id: string,
    occupiedNodes?: ReadonlySet<string>,
  ): Promise<string[]> {
    if (startNodeId === endNodeId) return [startNodeId];

    const [lockedNodes, edges, allNodes] = await Promise.all([
      this.findLockedNodeIds(map_id),
      this.edgeModel.find({ map_id, isLocked: { $ne: true } }).lean().exec(),
      this.nodeModel.find({ map_id }).lean().exec(),
    ]);

    if (edges.length === 0) {
      this.logger.warn(`[PathFind] map_id="${map_id}" 사용 가능한 엣지 없음`);
      return [];
    }

    // 충전소 판별을 위한 노드 타입(nodeType)만 저장 — 좌표는 다익스트라에 불필요
    const nodeType = new Map<string, string>();
    for (const n of allNodes) {
      nodeType.set(n.node_id, n.type);
    }

    const adj = new Map<string, { to: string; cost: number }[]>();
    const startIsCharger = nodeType.get(startNodeId) === NodeType.CHARGER;

    for (const edge of edges) {
      // 잠긴 노드는 경유 금지하되 경로의 출발/도착 노드 자신은 예외. 엣지는 양방향으로
      // 취급되므로 출발·도착 둘 다와 비교해야 한다 (아래 점유 노드 처리와 동일 규칙).
      const startLocked   = lockedNodes.has(edge.startNode)   && edge.startNode !== startNodeId && edge.startNode !== endNodeId;
      const endLocked     = lockedNodes.has(edge.endNode)     && edge.endNode   !== startNodeId && edge.endNode   !== endNodeId;
      const startOccupied = occupiedNodes?.has(edge.startNode) && edge.startNode !== startNodeId && edge.startNode !== endNodeId;
      const endOccupied   = occupiedNodes?.has(edge.endNode)   && edge.endNode   !== startNodeId && edge.endNode   !== endNodeId;
      if (startLocked || endLocked || startOccupied || endOccupied) continue;

      // 💡 weight ≤ 0 (비활성/차단 간선)만 제외 — 0.01 등 작은 양수는 유효한 저비용 간선
      if (edge.weight != null && edge.weight <= MIN_WEIGHT) continue;

      // CHARGER 경유 차단 로직
      if (!startIsCharger) {
        if (nodeType.get(edge.startNode) === NodeType.CHARGER && edge.startNode !== startNodeId && edge.startNode !== endNodeId) continue;
        if (nodeType.get(edge.endNode)   === NodeType.CHARGER && edge.endNode   !== startNodeId && edge.endNode   !== endNodeId) continue;
      }

      // 💡 fleet_edges의 weight를 간선 비용으로 그대로 사용 (표준 다익스트라: weight가 낮을수록 우선).
      //    weight 미지정 시 1로 간주. (weight ≤ MIN_WEIGHT 간선은 위에서 이미 제외되어 cost > 0 보장)
      const cost = edge.weight ?? 1;

      if (!adj.has(edge.startNode)) adj.set(edge.startNode, []);
      adj.get(edge.startNode)!.push({ to: edge.endNode, cost });

      if (!adj.has(edge.endNode)) adj.set(edge.endNode, []);
      adj.get(edge.endNode)!.push({ to: edge.startNode, cost });
    }

    if (!adj.has(startNodeId)) {
      this.logger.warn(`[PathFind] 출발노드 "${startNodeId}" 엣지 없음`);
    }

    // 다익스트라(Dijkstra): 누적 비용 gCost 기준으로만 노드를 확장
    const gCost  = new Map<string, number>();
    const parent = new Map<string, string>();
    const closed = new Set<string>(); // 방문 완료 노드 추적 (무한 루프 방지)

    // 우선순위 큐 (순수 누적 비용 gCost 기준으로만 정렬)
    const pq: { id: string; cost: number }[] = [];

    gCost.set(startNodeId, 0);
    pq.push({ id: startNodeId, cost: 0 });

    while (pq.length > 0) {
      pq.sort((a, b) => a.cost - b.cost);
      const { id: u, cost: currentG } = pq.shift()!;

      // 이미 확정된(더 짧은 경로로 방문한) 노드면 스킵
      if (closed.has(u)) continue;
      closed.add(u);

      // 목적지 도착!
      if (u === endNodeId) {
        return this.reconstructPath(parent, startNodeId, endNodeId);
      }

      // 인접 노드 탐색
      for (const { to: v, cost: edgeCost } of adj.get(u) ?? []) {
        if (closed.has(v)) continue;

        const tentativeG = currentG + edgeCost;
        if (tentativeG < (gCost.get(v) ?? Infinity)) {
          gCost.set(v, tentativeG);
          parent.set(v, u);
          pq.push({ id: v, cost: tentativeG });
        }
      }
    }

    this.logger.warn(`[PathFind] 경로 없음: ${startNodeId} → ${endNodeId}`);
    return [];
  }

  private reconstructPath(
    parent: Map<string, string>,
    start: string,
    end: string,
  ): string[] {
    const path: string[] = [];
    let cur = end;
    while (cur !== start) {
      path.unshift(cur);
      const p = parent.get(cur);
      if (!p) return [];
      cur = p;
    }
    path.unshift(start);
    return path;
  }

  // ── 좌표 기준 최근접 노드 탐색 ──────────────────────────────────────────────
  // robot.location 이 null일 때 AMCL 위치로 출발 노드를 결정하는 데 사용

  async findNearestNodeToPosition(x: number, y: number, map_id?: string): Promise<string | null> {
    // map_id가 없으면 전체 노드 대상 검색
    const baseFilter = map_id ? { map_id } : {};
    let nodes = await this.nodeModel.find({ ...baseFilter, isLocked: { $ne: true } }).lean().exec();
    if (nodes.length === 0) {
      nodes = await this.nodeModel.find(baseFilter).lean().exec();
    }
    if (nodes.length === 0) return null;

    let nearest: string | null = null;
    let minDist = Infinity;

    for (const node of nodes) {
      const d = Math.hypot(node.x - x, node.y - y);
      if (d < minDist) { minDist = d; nearest = node.node_id; }
    }
    return nearest;
  }

  // ── 위치 → 목적지 노드 거리 (노드 간 0.1 고정, A* 홉 수 기반) ─────────────────
  /**
   * 위치(x,y)에서 가장 가까운 노드 → 목적지 노드까지 A* 경로 거리.
   * 노드와 노드 사이를 0.1로 고정해 (홉 수 × 0.1)을 거리로 본다. 위치/목적지 미상·도달 불가 시 null.
   * (목적지 노드가 속한 맵을 스스로 찾아 그 맵에서 계산한다.)
   */
  async hopDistanceFromPosition(
    x: number | null | undefined, y: number | null | undefined, targetNodeId: string,
  ): Promise<number | null> {
    if (x == null || y == null) return null;
    const target = await this.nodeModel.findOne({ node_id: targetNodeId }).lean().exec();
    const mapId = target?.map_id;
    if (!mapId) return null;
    const startNode = await this.findNearestNodeToPosition(x, y, mapId);
    if (!startNode) return null;
    const path = await this.findPath(startNode, targetNodeId, mapId);
    if (path.length === 0) return null;          // 도달 불가
    return (path.length - 1) * NODE_HOP_DIST;    // 홉 수 × 0.1
  }
}
