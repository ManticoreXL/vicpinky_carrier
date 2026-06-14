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
}

export const NodeSchema = SchemaFactory.createForClass(Node);
