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

  // ── 경로 탐색 (BFS, 잠긴 엣지 제외) ──────────────────────────────────────

  async findPath(
    startNodeId: string,
    endNodeId: string,
    map_id: string,
  ): Promise<string[]> {
    if (startNodeId === endNodeId) return [startNodeId];

    const edges = await this.edgeModel.find({ map_id, isLocked: false }).lean().exec();

    // 인접 리스트 구성 (방향 고려)
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
      if (!adj.has(edge.startNode)) adj.set(edge.startNode, []);
      adj.get(edge.startNode)!.push(edge.endNode);

      if (edge.direction === EdgeDirection.BOTH_WAY) {
        if (!adj.has(edge.endNode)) adj.set(edge.endNode, []);
        adj.get(edge.endNode)!.push(edge.startNode);
      }
    }

    // BFS
    const visited = new Set<string>([startNodeId]);
    const parent = new Map<string, string>();
    const queue = [startNodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adj.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, current);
        if (neighbor === endNodeId) return this.reconstructPath(parent, startNodeId, endNodeId);
        queue.push(neighbor);
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
