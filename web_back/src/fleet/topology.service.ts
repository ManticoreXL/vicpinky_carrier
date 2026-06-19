import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Server } from 'socket.io';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';
import { Robot, RobotDocument } from './robot.schema';
import { Task, TaskDocument } from '../fms/task.schema';

// 이 값 이하(0 또는 음수)인 weight는 비활성/차단 간선으로 간주하여 제외.
// (표준 다익스트라는 양수 비용을 요구 — 0.01 같은 작은 양수는 정상적인 저비용 간선이다)
const MIN_WEIGHT = 0;

@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);
  private server: Server | null = null;

  constructor(
    @InjectModel(Node.name)  private readonly nodeModel:  Model<NodeDocument>,
    @InjectModel(Edge.name)  private readonly edgeModel:  Model<EdgeDocument>,
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(Task.name)  private readonly taskModel:  Model<TaskDocument>,
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
  //   - weight <= 0 → 비활성/차단 간선으로 제외
  //   - 비용 = weight: 표준 다익스트라(가중치 낮을수록 우선 선택)

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
      this.logger.warn(`[PathFind] map_id="${map_id}" 사용 가능한 엣지 없음`);
      return [];
    }

    // 💡 물리적 좌표(nodePos)는 무시하고, 충전소 판별을 위한 타입(nodeType)만 저장
    const nodeType = new Map<string, string>();
    for (const n of allNodes) {
      nodeType.set(n.node_id, n.type);
    }

    const adj = new Map<string, { to: string; cost: number }[]>();
    const startIsCharger = nodeType.get(startNodeId) === NodeType.CHARGER;

    for (const edge of edges) {
      const startLocked = lockedNodes.has(edge.startNode) && edge.startNode !== startNodeId;
      const endLocked   = lockedNodes.has(edge.endNode)   && edge.endNode   !== endNodeId;
      if (startLocked || endLocked) continue;

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

    // 💡 A*에서 휴리스틱을 뺀 다익스트라(Dijkstra) 방식으로 탐색
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

  // ── ID 변경 (cascade) ─────────────────────────────────────────────────────

  async renameNodeId(oldId: string, newId: string): Promise<NodeDocument> {
    const node = await this.nodeModel.findOneAndUpdate(
      { node_id: oldId },
      { node_id: newId },
      { new: true },
    );
    if (!node) throw new NotFoundException(`Node ${oldId} 없음`);

    await Promise.all([
      this.edgeModel.updateMany({ startNode: oldId }, { startNode: newId }),
      this.edgeModel.updateMany({ endNode: oldId },   { endNode: newId }),
      this.robotModel.updateMany({ location: oldId }, { location: newId }),
      this.taskModel.updateMany({ targetNode: oldId }, { targetNode: newId }),
      this.taskModel.updateMany({ startNode: oldId },  { startNode: newId }),
      this.taskModel.updateMany(
        { pathQueue: oldId },
        { $set: { 'pathQueue.$[elem]': newId } },
        { arrayFilters: [{ elem: { $eq: oldId } }] },
      ),
    ]);

    this.logger.log(`Node ID 변경: ${oldId} → ${newId} (cascade 완료)`);
    return node;
  }

  async renameEdgeId(oldId: string, newId: string): Promise<EdgeDocument> {
    const edge = await this.edgeModel.findOneAndUpdate(
      { edge_id: oldId },
      { edge_id: newId },
      { new: true },
    );
    if (!edge) throw new NotFoundException(`Edge ${oldId} 없음`);
    this.logger.log(`Edge ID 변경: ${oldId} → ${newId}`);
    return edge;
  }
}
