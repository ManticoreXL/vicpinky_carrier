import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Server } from 'socket.io';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';
import { Robot, RobotDocument } from '../robot/robot.schema';
import { Task, TaskDocument } from '../fms/task.schema';

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
