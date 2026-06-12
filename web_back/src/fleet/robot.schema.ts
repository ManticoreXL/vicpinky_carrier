import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum RobotStatus {
  IDLE     = 'IDLE',
  MOVING   = 'MOVING',
  WORKING  = 'WORKING',
  ERROR    = 'ERROR',
  OFFLINE  = 'OFFLINE',
}

export type RobotDocument = HydratedDocument<Robot>;

@Schema({ timestamps: true, collection: 'fleet_robots' })
export class Robot {
  @Prop({ required: true, unique: true, index: true })
  robot_id: string;

  @Prop({ required: true, enum: RobotStatus, default: RobotStatus.OFFLINE, index: true })
  status: RobotStatus;

  @Prop({ default: null })
  location: string | null; // 현재 위치한 node_id

  @Prop({ required: true })
  ip: string;

  @Prop({ required: true })
  ros_domain_id: number;
}

export const RobotSchema = SchemaFactory.createForClass(Robot);
