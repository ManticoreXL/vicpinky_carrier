import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Server } from 'socket.io';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';

// 이 임계값 이하인 엣지는 진입 불가 (비메인 도로 차단용)
const MIN_WEIGHT = 0.1;

@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);
  private server: Server | null = null;

  constructor(
    @InjectModel(Node.name) private readonly nodeModel: Model<NodeDocument>,
    @InjectModel(Edge.name) private readonly edgeModel: Model<EdgeDocument>,
  ) {}

  setServer(server: Server) { this.server = server; }

  // ── Node CRUD ─────────────────────────────────────────────────────────────

  async createNode(dto: Partial<Node>): Promise<NodeDocument> {
    return this.nodeModel.create(dto);
  }

  async findAllNodes(map_id?: string): Promise<NodeDocument[]> {
    const filter = map_id ? { map_id } : {};
    return this.nodeModel.find(filter).lean().exec() as unknown as NodeDocument[];
  }

  async findNodeById(node_id: string): Promise<NodeDocument | null> {
    return this.nodeModel.findOne({ node_id }).exec();
  }

  async updateNode(node_id: string, dto: Partial<Node>): Promise<NodeDocument> {
    const doc = await this.nodeModel.findOneAndUpdate({ node_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Node ${node_id} 없음`);
    return doc;
  }

  async removeNode(node_id: string): Promise<void> {
    await this.nodeModel.deleteOne({ node_id });
  }

  async findNodesByType(map_id: string, type: NodeType): Promise<NodeDocument[]> {
    return this.nodeModel.find({ map_id, type }).exec();
  }

  // ── Edge CRUD ─────────────────────────────────────────────────────────────

  async createEdge(dto: Partial<Edge>): Promise<EdgeDocument> {
    return this.edgeModel.create(dto);
  }

  async findAllEdges(map_id?: string): Promise<EdgeDocument[]> {
    const filter = map_id ? { map_id } : {};
    return this.edgeModel.find(filter).lean().exec() as unknown as EdgeDocument[];
  }

  async findEdgeById(edge_id: string): Promise<EdgeDocument | null> {
    return this.edgeModel.findOne({ edge_id }).exec();
  }

  async updateEdge(edge_id: string, dto: Partial<Edge>): Promise<EdgeDocument> {
    const doc = await this.edgeModel.findOneAndUpdate({ edge_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Edge ${edge_id} 없음`);
    return doc;
  }

  async removeEdge(edge_id: string): Promise<void> {
    await this.edgeModel.deleteOne({ edge_id });
  }

  async setLocked(edge_id: string, isLocked: boolean): Promise<void> {
    await this.edgeModel.updateOne({ edge_id }, { isLocked });
  }

  // ── 경로 탐색 ─────────────────────────────────────────────────────────────
  //
  // 정책:
  //   - isLocked=true 엣지 → 완전 제외
  //   - weight <= MIN_WEIGHT(0.1) → 진입 불가 (비메인 도로 차단)
  //   - 비용 = 1/weight: 가중치 높을수록(메인 도로) 우선 선택

  async setNodeLocked(node_id: string, isLocked: boolean): Promise<void> {
    await this.nodeModel.updateOne({ node_id }, { isLocked });
    this.server?.emit('node_lock_changed', { node_id, isLocked });
  }

  async findLockedNodeIds(map_id: string): Promise<Set<string>> {
    const locked = await this.nodeModel.find({ map_id, isLocked: true }).lean().exec();
    return new Set(locked.map(n => n.node_id));
  }

  async getAllLockedNodeIds(): Promise<string[]> {
    const locked = await this.nodeModel.find({ isLocked: true }).lean().exec();
    return locked.map(n => n.node_id);
  }

  async findPath(
    startNodeId: string,
    endNodeId: string,
    map_id: string,
  ): Promise<string[]> {
    if (startNodeId === endNodeId) return [startNodeId];

    const [lockedNodes, edges, allNodes] = await Promise.all([
      this.findLockedNodeIds(map_id),
      this.edgeModel.find({ map_id, isLocked: { $ne: true } }).lean().exec(),
      this.nodeModel.find({ map_id }).lean().exec(),
    ]);

    if (edges.length === 0) {
      this.logger.warn(`[A*] map_id="${map_id}" 사용 가능한 엣지 없음`);
      return [];
    }

    // 노드 위치·타입 맵 (휴리스틱 + CHARGER 경유 제외용)
    const nodePos  = new Map<string, { x: number; y: number }>();
    const nodeType = new Map<string, string>();
    for (const n of allNodes) {
      nodePos.set(n.node_id, { x: n.x, y: n.y });
      nodeType.set(n.node_id, n.type);
    }

    const goalPos = nodePos.get(endNodeId);
    const h = (nodeId: string): number => {
      if (!goalPos) return 0;
      const pos = nodePos.get(nodeId);
      if (!pos) return 0;
      return Math.hypot(pos.x - goalPos.x, pos.y - goalPos.y);
    };

    // 인접 리스트 구성
    const adj = new Map<string, { to: string; cost: number }[]>();

    // 출발이 CHARGER이면 (충전소에서 출발) 주변 CHARGER 경유 허용
    const startIsCharger = nodeType.get(startNodeId) === NodeType.CHARGER;

    for (const edge of edges) {
      const startLocked = lockedNodes.has(edge.startNode) && edge.startNode !== startNodeId;
      const endLocked   = lockedNodes.has(edge.endNode)   && edge.endNode   !== endNodeId;
      if (startLocked || endLocked) continue;

      // CHARGER 노드는 출발·목적지가 아닌 이상 경유 불가 (충전 전용 노드)
      // 단, 출발 자체가 CHARGER인 경우엔 탈출 경로 확보를 위해 CHARGER 경유 허용
      if (!startIsCharger) {
        if (nodeType.get(edge.startNode) === NodeType.CHARGER && edge.startNode !== startNodeId && edge.startNode !== endNodeId) continue;
        if (nodeType.get(edge.endNode)   === NodeType.CHARGER && edge.endNode   !== startNodeId && edge.endNode   !== endNodeId) continue;
      }

      const w    = Math.max(edge.weight ?? 1, 0.01);
      const cost = 1 / w;

      if (!adj.has(edge.startNode)) adj.set(edge.startNode, []);
      adj.get(edge.startNode)!.push({ to: edge.endNode, cost });

      if (edge.direction === EdgeDirection.BOTH_WAY) {
        if (!adj.has(edge.endNode)) adj.set(edge.endNode, []);
        adj.get(edge.endNode)!.push({ to: edge.startNode, cost });
      }
    }

    if (!adj.has(startNodeId)) {
      this.logger.warn(`[A*] 출발노드 "${startNodeId}" 엣지 없음`);
    }

    // A* 탐색
    const gCost  = new Map<string, number>();
    const parent = new Map<string, string>();
    const pq: { id: string; f: number }[] = [];
    gCost.set(startNodeId, 0);
    pq.push({ id: startNodeId, f: h(startNodeId) });

    while (pq.length > 0) {
      pq.sort((a, b) => a.f - b.f);
      const { id: u } = pq.shift()!;

      if (u === endNodeId) {
        return this.reconstructPath(parent, startNodeId, endNodeId);
      }

      const gU = gCost.get(u) ?? Infinity;
      for (const { to: v, cost } of adj.get(u) ?? []) {
        const tentativeG = gU + cost;
        if (tentativeG < (gCost.get(v) ?? Infinity)) {
          gCost.set(v, tentativeG);
          parent.set(v, u);
          pq.push({ id: v, f: tentativeG + h(v) });
        }
      }
    }

    this.logger.warn(`[A*] 경로 없음: ${startNodeId} → ${endNodeId}`);
    return [];
  }

  // ── 최근접 스테이션/충전소 탐색 ──────────────────────────────────────────
  //
  // 점유 대기 중인 로봇을 가장 가까운 STATION/CHARGER 노드로 안내할 때 사용

  async findNearestStation(
    fromNodeId: string,
    map_id: string,
  ): Promise<string | null> {
    const stations = await this.nodeModel
      .find({ map_id, type: { $in: [NodeType.STATION, NodeType.CHARGER] } })
      .lean()
      .exec();

    if (stations.length === 0) return null;

    let nearest: string | null = null;
    let minHops = Infinity;

    for (const st of stations) {
      if (st.node_id === fromNodeId) return fromNodeId;
      const path = await this.findPath(fromNodeId, st.node_id, map_id);
      if (path.length > 0 && path.length < minHops) {
        minHops  = path.length;
        nearest  = st.node_id;
      }
    }

    return nearest;
  }

  // ── 좌표 기준 최근접 노드 탐색 ──────────────────────────────────────────────
  // robot.location 이 null일 때 AMCL 위치로 출발 노드를 결정하는 데 사용

  async findNearestNodeToPosition(
    x: number,
    y: number,
    map_id?: string,
  ): Promise<string | null> {
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
}
