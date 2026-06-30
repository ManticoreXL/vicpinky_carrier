import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { RosStep, RosStepSchema, TaskType } from '../fms/task.schema';

export type TaskDocument = HydratedDocument<Task>;

/**
 * Task(정의) — 재사용 가능한 '한 로봇 작업' 템플릿. 실행 레코드(TaskHistory)와 별개.
 *  steps = move/service/topic/wait 혼합 스텝. 비우면 type+targetNode 로 dispatch 가 표준 플랜 생성.
 *  실행 시 robotId·경로(pathQueue/fullPath)는 dispatch 가 채운다.
 */
@Schema({ timestamps: true, collection: 'fms_task_defs' })
export class Task {
  @Prop({ required: true, index: true })
  name: string;                                   // 사용자 지정 이름

  @Prop({ type: String, required: true, enum: TaskType, default: TaskType.MOVE })
  type: TaskType;

  /** 권장 로봇 (null = 배차가 선택) */
  @Prop({ type: String, default: null })
  preferredRobotId: string | null;

  /** move 류 목적지 노드 */
  @Prop({ type: String, default: '' })
  targetNode: string;

  /** 우선순위 1=긴급 … 5=보통 … 10=낮음 (실행 시 큐 정렬에 사용) */
  @Prop({ type: Number, default: 5 })
  priority: number;

  /** 반복 수행 — true면 한 사이클(전 스텝) 완료 후 자동 재시작(정지 명령 전까지). */
  @Prop({ type: Boolean, default: false })
  repeat: boolean;

  // ── 생성 조건(트리거) — auto 모드 ON일 때 이 ROS 신호가 맞으면 이 태스크를 자동 생성·배차 ──
  /** 트리거 토픽(비우면 자동 생성 안 함). */
  @Prop({ type: String, default: '' })
  triggerTopic: string;
  /** 메시지에서 비교할 필드(dot-path). 빈값 = 메시지 수신만으로 트리거. */
  @Prop({ type: String, default: '' })
  triggerField: string;
  /** 기대값. null = 필드 truthy(또는 메시지 존재)만으로 트리거. */
  @Prop({ type: Object, default: null })
  triggerValue: unknown;

  /** 혼합 스텝 리스트(옵션). 비우면 type 으로 표준 플랜 생성 */
  @Prop({ type: [RosStepSchema], default: [] })
  steps: RosStep[];

  @Prop({ type: String, default: '' })
  description: string;
}
export const TaskSchema = SchemaFactory.createForClass(Task);

/** 시퀀스 항목 — Task(정의) 참조 + 순번/로봇 override. seq 작을수록 먼저. */
@Schema({ _id: false })
export class SequenceItem {
  @Prop({ required: true })
  seq: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: Task.name, required: true })
  task: Types.ObjectId;

  /** 이 단계를 수행할 로봇 (override). null = 정의값/배차 */
  @Prop({ type: String, default: null })
  robotId: string | null;
}
export const SequenceItemSchema = SchemaFactory.createForClass(SequenceItem);

export type TaskSequenceDocument = HydratedDocument<TaskSequence>;

/**
 * TaskSequence — 저장된 커스텀 시나리오. items(seq 순)로 Task 정의들을 순차 핸드오프.
 *  populate('items.task')로 시퀀스 + 정의들을 "한꺼번에" 로드.
 */
@Schema({ timestamps: true, collection: 'fms_task_sequences' })
export class TaskSequence {
  @Prop({ required: true, index: true })
  name: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: [SequenceItemSchema], default: [] })
  items: SequenceItem[];
}
export const TaskSequenceSchema = SchemaFactory.createForClass(TaskSequence);
