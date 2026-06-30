import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Server } from 'socket.io';
import { Node, NodeDocument, NodeType } from './node.schema';
import { Edge, EdgeDocument, EdgeDirection } from './edge.schema';
import { Robot, RobotDocument } from '../robot/robot.schema';
import { TaskHistory, TaskHistoryDocument } from '../fms/task.schema';

@Injectable()
export class TopologyService implements OnModuleInit {
  private readonly logger = new Logger(TopologyService.name);
  private server: Server | null = null;

  constructor(
    @InjectModel(Node.name)  private readonly nodeModel:  Model<NodeDocument>,
    @InjectModel(Edge.name)  private readonly edgeModel:  Model<EdgeDocument>,
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(TaskHistory.name)  private readonly taskModel:  Model<TaskHistoryDocument>,
  ) {}

  // 스키마에 isLockedBy를 추가한 뒤, 그 필드가 없는 기존 노드 문서에 null을 백필한다.
  // (Mongoose의 default는 신규 생성/저장 시에만 적용되므로 기존 문서엔 컬럼이 없다)
  async onModuleInit(): Promise<void> {
    const res = await this.nodeModel.updateMany(
      { isLockedBy: { $exists: false } },
      { $set: { isLockedBy: null } },
    );
    if (res.modifiedCount) this.logger.log(`[migration] isLockedBy 백필 — 노드 ${res.modifiedCount}개`);

    // initPosition 컬럼 백필 (기존 노드 문서엔 기본 false)
    const initRes = await this.nodeModel.updateMany(
      { initPosition: { $exists: false } },
      { $set: { initPosition: false } },
    );
    if (initRes.modifiedCount) this.logger.log(`[migration] initPosition 백필 — 노드 ${initRes.modifiedCount}개`);

    // 고아 엣지 정리 — 양 끝 노드 중 하나라도 실재하지 않는 엣지 제거(삭제 노드 잔재).
    // cascade 도입 이전에 남은 잔재 + 방어. 경로탐색/연결판정을 오염시키므로 기동 시 1회 청소.
    const [nodeIdDocs, edgeDocs] = await Promise.all([
      this.nodeModel.find({}, { node_id: 1 }).lean().exec(),
      this.edgeModel.find({}, { edge_id: 1, startNode: 1, endNode: 1 }).lean().exec(),
    ]);
    const ids = new Set(nodeIdDocs.map((n) => n.node_id));
    const orphanEdgeIds = edgeDocs.filter((e) => !ids.has(e.startNode) || !ids.has(e.endNode)).map((e) => e.edge_id);
    if (orphanEdgeIds.length) {
      await this.edgeModel.deleteMany({ edge_id: { $in: orphanEdgeIds } });
      this.logger.log(`[고아엣지정리] 삭제 노드 참조 엣지 ${orphanEdgeIds.length}개 제거`);
    }
  }

  setServer(server: Server) { this.server = server; }

  // ── Node CRUD ─────────────────────────────────────────────────────────────

  async createNode(dto: Partial<Node>): Promise<NodeDocument> {
    // 초기위치로 만들면 같은 맵의 기존 노드는 전부 해제 (맵당 하나만)
    if (dto.initPosition === true && dto.map_id) {
      await this.nodeModel.updateMany({ map_id: dto.map_id }, { $set: { initPosition: false } });
    }
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
    // 초기위치를 켜면 같은 맵의 다른 노드는 자동 해제 (맵당 하나만)
    if (dto.initPosition === true) {
      const existing = await this.nodeModel.findOne({ node_id }).lean().exec();
      const mapId = dto.map_id ?? existing?.map_id;
      if (mapId) {
        await this.nodeModel.updateMany(
          { map_id: mapId, node_id: { $ne: node_id } },
          { $set: { initPosition: false } },
        );
      }
    }
    const doc = await this.nodeModel.findOneAndUpdate({ node_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Node ${node_id} 없음`);
    return doc;
  }

  async removeNode(node_id: string): Promise<void> {
    await this.nodeModel.deleteOne({ node_id });
    // cascade: 이 노드에 연결된 엣지도 함께 삭제(고아 엣지 방지). startNode/endNode 어느 쪽이든 참조하면 제거.
    // (임시 VICTIM 노드처럼 동적 생성된 노드를 지울 때 연결 엣지가 남지 않도록)
    const res = await this.edgeModel.deleteMany({ $or: [{ startNode: node_id }, { endNode: node_id }] });
    this.logger.log(`Node 삭제: ${node_id} (연결 엣지 ${res.deletedCount ?? 0}개 cascade 삭제)`);
  }

  async findNodesByType(map_id: string, type: NodeType): Promise<NodeDocument[]> {
    return this.nodeModel.find({ map_id, type }).exec();
  }

  /** 맵의 초기 위치 노드 (initPosition=true, 맵당 하나). 없으면 null. */
  async findInitPositionNode(map_id: string): Promise<NodeDocument | null> {
    return this.nodeModel.findOne({ map_id, initPosition: true }).exec();
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
