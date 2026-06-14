import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';

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

  // ── 경로 탐색 (다익스트라, 잠긴 엣지 제외, 가중치 반영) ──────────────────────────────────────

  async findPath(
    startNodeId: string,
    endNodeId: string,
    map_id: string,
  ): Promise<string[]> {
    if (startNodeId === endNodeId) return [startNodeId];

    const edges = await this.edgeModel.find({ map_id, isLocked: false }).lean().exec();

    // 인접 리스트 구성: 노드 -> { 이웃, 가중치 }
    const adj = new Map<string, { to: string; weight: number }[]>();
    for (const edge of edges) {
      const w = edge.weight ?? 1;
      if (!adj.has(edge.startNode)) adj.set(edge.startNode, []);
      adj.get(edge.startNode)!.push({ to: edge.endNode, weight: w });

      if (edge.direction === EdgeDirection.BOTH_WAY) {
        if (!adj.has(edge.endNode)) adj.set(edge.endNode, []);
        adj.get(edge.endNode)!.push({ to: edge.startNode, weight: w });
      }
    }

    // 다익스트라 (우선순위 큐 대신 단순 배열 + 정렬 사용 - 노드 개수 적으므로 충분)
    const dist = new Map<string, number>();
    const parent = new Map<string, string>();
    const pq: { id: string; d: number }[] = [{ id: startNodeId, d: 0 }];
    
    dist.set(startNodeId, 0);

    while (pq.length > 0) {
      pq.sort((a, b) => a.d - b.d);
      const { id: u, d: distU } = pq.shift()!;

      if (u === endNodeId) return this.reconstructPath(parent, startNodeId, endNodeId);

      const currentDist = dist.get(u) ?? Infinity;
      if (distU > currentDist) continue;

      for (const neighbor of adj.get(u) ?? []) {
        const v = neighbor.to;
        const alt = distU + neighbor.weight;
        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          parent.set(v, u);
          pq.push({ id: v, d: alt });
        }
      }
    }

    return []; // 경로 없음
  }

  private reconstructPath(parent: Map<string, string>, start: string, end: string): string[] {
    const path: string[] = [];
    let cur = end;
    while (cur !== start) {
      path.unshift(cur);
      cur = parent.get(cur)!;
    }
    path.unshift(start);
    return path;
  }
}
