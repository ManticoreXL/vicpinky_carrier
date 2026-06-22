import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum NodeType {
  WAYPOINT = 'WAYPOINT',
  STATION  = 'STATION',
  CHARGER  = 'CHARGER',
}

export type NodeDocument = HydratedDocument<Node>;

@Schema({ collection: 'fleet_nodes' })
export class Node {
  @Prop({ required: true, unique: true, index: true })
  node_id: string;

  @Prop({ required: true, index: true })
  map_id: string;

  @Prop({ required: true, enum: NodeType })
  type: NodeType;

  @Prop({ required: true })
  x: number;

  @Prop({ required: true })
  y: number;

  @Prop({ required: true })
  yaw: number;

  /** 노드 폐쇄 여부 — true 이면 경로 탐색에서 제외 (다익스트라 우회) */
  @Prop({ default: false })
  isLocked: boolean;

  /**
   * 충전소 점유 로봇 ID (CHARGER 노드 한정 의미).
   * 로봇이 충전소에 도착하면 그 robot_id를 기록하고, 떠날 때(새 태스크 시작) null로 해제한다.
   * 자동충전 선택 시 isLockedBy가 채워진(=다른 로봇이 점유한) 충전소는 후보에서 제외한다.
   */
  @Prop({ type: String, default: null })
  isLockedBy: string | null;
}

export const NodeSchema = SchemaFactory.createForClass(Node);
