import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TaskStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';
export type TaskType   = 'explore' | 'deliver' | 'stop' | 'diagnose' | 'carrier_task' | 'emergency_stop';
export type TaskDocument = HydratedDocument<Task>;

@Schema({ timestamps: true, collection: 'fms_tasks' })
export class Task {
  @Prop({ required: true, index: true })
  robotId: string;

  @Prop({ required: true })
  type: TaskType;

  @Prop({ required: true, default: 'queued', index: true })
  status: TaskStatus;

  @Prop()
  targetId?: string;

  @Prop()
  notes?: string;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop({ type: Object })
  result?: Record<string, unknown>;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
