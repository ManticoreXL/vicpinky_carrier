import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Server } from 'socket.io';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';
import { Robot, RobotDocument } from '../robot/robot.schema';
import { Task, TaskDocument } from '../fms/task.schema';

@Injectable()
export class TopologyService implements OnModuleInit {
  private readonly logger = new Logger(TopologyService.name);
  private server: Server | null = null;

  constructor(
    @InjectModel(Node.name)  private readonly nodeModel:  Model<NodeDocument>,
    @InjectModel(Edge.name)  private readonly edgeModel:  Model<EdgeDocument>,
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(Task.name)  private readonly taskModel:  Model<TaskDocument>,
  ) {}

  // 스키마에 isLockedBy를 추가한 뒤, 그 필드가 없는 기존 노드 문서에 null을 백필한다.
  // (Mongoose의 default는 신규 생성/저장 시에만 적용되므로 기존 문서엔 컬럼이 없다)
  async onModuleInit(): Promise<void> {
    const res = await this.nodeModel.updateMany(
      { isLockedBy: { $exists: false } },
      { $set: { isLockedBy: null } },
    );
    if (res.modifiedCount) this.logger.log(`[migration] isLockedBy 백필 — 노드 ${res.modifiedCount}개`);
  }

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

  // ── 충전소 점유(isLockedBy) ──────────────────────────────────────────────────
  // 로봇이 충전소에 도착하면 robot_id 기록, 떠날 때 null로 해제.

  async setChargerLockedBy(node_id: string, robotId: string | null): Promise<void> {
    await this.nodeModel.updateOne({ node_id }, { isLockedBy: robotId });
  }

  /** 해당 로봇이 점유 중이던 충전소를 해제 (새 태스크로 출발할 때).
   *  exceptNodeId를 주면 그 노드는 해제하지 않는다(이번 충전 목적지 예약 보존용). */
  async releaseChargersLockedBy(robotId: string, exceptNodeId?: string): Promise<void> {
    const filter: Record<string, unknown> = { isLockedBy: robotId };
    if (exceptNodeId) filter.node_id = { $ne: exceptNodeId };
    await this.nodeModel.updateMany(filter, { isLockedBy: null });
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

  // ── 노드 잠금 ─────────────────────────────────────────────────────────────
  // (실제 경로 탐색은 PathfindingService 가 담당)

  async setNodeLocked(node_id: string, isLocked: boolean): Promise<void> {
    await this.nodeModel.updateOne({ node_id }, { isLocked });
    this.server?.emit('node_lock_changed', { node_id, isLocked });
  }

  async getAllLockedNodeIds(): Promise<string[]> {
    const locked = await this.nodeModel.find({ isLocked: true }).lean().exec();
    return locked.map(n => n.node_id);
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
