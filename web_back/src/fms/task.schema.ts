import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum TaskType {
  SUPPLY     = 'SUPPLY',
  PROCESS    = 'PROCESS',
  DISTRIBUTE = 'DISTRIBUTE',
  CHARGE     = 'CHARGE',
}

export enum TaskStatus {
  PENDING   = 'PENDING',
  ASSIGNED  = 'ASSIGNED',
  RUNNING   = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED    = 'FAILED',
}

export type TaskDocument = HydratedDocument<Task>;

@Schema({ timestamps: true, collection: 'fms_tasks' })
export class Task {
  @Prop({ required: true, unique: true, index: true })
  task_id: string;

  @Prop({ required: true, enum: TaskType })
  type: TaskType;

  @Prop({ required: true, enum: TaskStatus, default: TaskStatus.PENDING, index: true })
  status: TaskStatus;

  @Prop({ required: true })
  targetNode: string;

  /** 1=긴급 … 5=보통 … 10=낮음 */
  @Prop({ default: 5, index: true })
  priority: number;

  @Prop()
  waitReason?: string;

  @Prop({
    type: {
      robot_id:     { type: String,  default: null  },
      is_completed: { type: Boolean, default: false },
    },
    default: { robot_id: null, is_completed: false },
  })
  assignedRobot: { robot_id: string | null; is_completed: boolean };

  /** 경로 탐색으로 생성된 남은 waypoint 목록 */
  @Prop({ type: [String], default: [] })
  pathQueue: string[];

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop({ type: Object })
  result?: Record<string, unknown>;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
