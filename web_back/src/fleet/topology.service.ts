import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';

// 이 임계값 이하인 엣지는 진입 불가 (비메인 도로 차단용)
const MIN_WEIGHT = 0.1;

@Injectable()
export class TopologyService {
  constructor(
    @InjectModel(Node.name) private readonly nodeModel: Model<NodeDocument>,
    @InjectModel(Edge.name) private readonly edgeModel: Model<EdgeDocument>,
  ) {}

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
  //   - occupiedEdges: "A→B" 형식으로 다른 로봇이 점유한 엣지

  async findPath(
    startNodeId: string,
    endNodeId: string,
    map_id: string,
    occupiedEdges: Set<string> = new Set(),
  ): Promise<string[]> {
    if (startNodeId === endNodeId) return [startNodeId];

    const edges = await this.edgeModel
      .find({ map_id, isLocked: false, weight: { $gt: MIN_WEIGHT } })
      .lean()
      .exec();

    const adj = new Map<string, { to: string; cost: number }[]>();

    for (const edge of edges) {
      const w    = edge.weight ?? 1;
      const cost = 1 / w;            // 높은 가중치 = 낮은 비용 = 다익스트라 우선

      const fwdKey = `${edge.startNode}→${edge.endNode}`;
      if (!occupiedEdges.has(fwdKey)) {
        if (!adj.has(edge.startNode)) adj.set(edge.startNode, []);
        adj.get(edge.startNode)!.push({ to: edge.endNode, cost });
      }

      if (edge.direction === EdgeDirection.BOTH_WAY) {
        const bwdKey = `${edge.endNode}→${edge.startNode}`;
        if (!occupiedEdges.has(bwdKey)) {
          if (!adj.has(edge.endNode)) adj.set(edge.endNode, []);
          adj.get(edge.endNode)!.push({ to: edge.startNode, cost });
        }
      }
    }

    // 다익스트라 (소규모 그래프용 단순 배열 정렬)
    const dist   = new Map<string, number>();
    const parent = new Map<string, string>();
    const pq: { id: string; d: number }[] = [{ id: startNodeId, d: 0 }];
    dist.set(startNodeId, 0);

    while (pq.length > 0) {
      pq.sort((a, b) => a.d - b.d);
      const { id: u, d: distU } = pq.shift()!;
      if (u === endNodeId) return this.reconstructPath(parent, startNodeId, endNodeId);
      if (distU > (dist.get(u) ?? Infinity)) continue;

      for (const { to: v, cost } of adj.get(u) ?? []) {
        const alt = distU + cost;
        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          parent.set(v, u);
          pq.push({ id: v, d: alt });
        }
      }
    }

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
    map_id: string,
  ): Promise<string | null> {
    const nodes = await this.nodeModel.find({ map_id }).lean().exec();
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
