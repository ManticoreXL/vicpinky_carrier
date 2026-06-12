import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum EdgeDirection {
  ONE_WAY  = 'ONE_WAY',
  BOTH_WAY = 'BOTH_WAY',
}

export type EdgeDocument = HydratedDocument<Edge>;

@Schema({ collection: 'fleet_edges' })
export class Edge {
  @Prop({ required: true, unique: true, index: true })
  edge_id: string;

  @Prop({ required: true, index: true })
  map_id: string;

  @Prop({ required: true })
  startNode: string;

  @Prop({ required: true })
  endNode: string;

  @Prop({ required: true, enum: EdgeDirection })
  direction: EdgeDirection;

  @Prop({ default: false })
  isLocked: boolean;
}

export const EdgeSchema = SchemaFactory.createForClass(Edge);
