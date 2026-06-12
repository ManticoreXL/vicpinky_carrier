import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FleetMapDocument = HydratedDocument<FleetMap>;

@Schema({ timestamps: true, collection: 'fleet_maps' })
export class FleetMap {
  @Prop({ required: true, unique: true, index: true })
  map_id: string;

  /** { "tb3_01": { x: 0.0, y: 0.0, yaw: 0 }, ... } */
  @Prop({ type: Object, default: {} })
  init_position: Record<string, { x: number; y: number; yaw: number }>;
}

export const FleetMapSchema = SchemaFactory.createForClass(FleetMap);
