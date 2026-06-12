import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TaskStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';
export type TaskType   = 'explore' | 'deliver' | 'stop' | 'diagnose' | 'carrier_task' | 'emergency_stop' | 'navigate';
export type TaskDocument = HydratedDocument<Task>;

@Schema({ timestamps: true, collection: 'fms_tasks' })
export class Task {
  @Prop({ required: true, index: true })
  robotId: string;

  @Prop({ required: true })
  type: TaskType;

  @Prop({ required: true, default: 'queued', index: true })
  status: TaskStatus;

  /** 1=긴급 … 5=보통 … 10=낮음. 낮을수록 먼저 실행 */
  @Prop({ default: 5, index: true })
  priority: number;

  @Prop()
  targetId?: string;

  @Prop()
  notes?: string;

  /** 대기 중인 이유 (배터리 부족, 오프라인 등) */
  @Prop()
  waitReason?: string;

  /** navigate 태스크 목표 좌표 */
  @Prop() goalX?: number;
  @Prop() goalY?: number;
  @Prop() goalYaw?: number;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop({ type: Object })
  result?: Record<string, unknown>;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
