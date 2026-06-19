import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum TaskType {
  SUPPLY      = 'SUPPLY',
  PROCESS     = 'PROCESS',
  CHARGE      = 'CHARGE',
  MOVE        = 'MOVE',
}

export enum TaskStatus {
  DRAFT     = 'DRAFT',     // 등록만 된 상태 — 자동 배차 대상 아님 (관제가 수동 배차)
  PENDING   = 'PENDING',
  ASSIGNED  = 'ASSIGNED',
  RUNNING   = 'RUNNING',
  SUSPENDED = 'SUSPENDED', // 관제 조치 대기 (다이어그램의 AlertTower 상태)
  COMPLETED = 'COMPLETED',
  FAILED    = 'FAILED',    // 완전히 복구 불가능한 실패
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

  // 단순 목적지뿐만 아니라, 이 작업이 시작된 위치도 알면 Node Lock 해제 시 유리합니다.
  @Prop({ type: String, default: null })
  startNode: string | null;

  @Prop({ required: true })
  targetNode: string;

  /** 1=긴급 … 5=보통 … 10=낮음 */
  @Prop({ default: 5, index: true })
  priority: number;

  @Prop()
  waitReason?: string;

  // 객체 형태를 버리고 로봇 ID만 매핑하여 Single Source of Truth 유지
  @Prop({ type: String, default: null, index: true })
  assignedRobotId: string | null;

  /** 특정 로봇에게 배정 요청 (null = 임의 배정) */
  @Prop({ type: String, default: null })
  preferredRobotId: string | null;

  /** 공급/가공 시 수량, 작동 시간 등 구체적인 명령 파라미터 */
  @Prop({ type: Object, default: {} })
  actionPayload?: Record<string, any>;

  /** 경로 탐색으로 생성된 남은 waypoint 목록 (진행하면서 shrink) */
  @Prop({ type: [String], default: [] })
  pathQueue: string[];

  /** 배정 시점에 확정된 전체 경로 (변경 없음, 시각화용) */
  @Prop({ type: [String], default: [] })
  fullPath: string[];

  // 에러 발생 시 원인 파악 및 관제 화면 표시용
  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop({ type: Object })
  result?: Record<string, unknown>;
}

export const TaskSchema = SchemaFactory.createForClass(Task);