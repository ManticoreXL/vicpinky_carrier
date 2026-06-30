import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum TaskType {
  SUPPLY      = 'SUPPLY',
  PROCESS     = 'PROCESS',
  CHARGE      = 'CHARGE',
  MOVE        = 'MOVE',
  RECALL      = 'RECALL',   // 복귀 — 현재 맵 초기위치(initPosition) 노드로 이동. 고우선 + 보유 태스크 글로벌 큐 반납.
  PAUSE       = 'PAUSE',    // 일시정지 — 현재 위치에서 즉시 정지 + 진행 태스크 SUSPENDED 보류(재개 시 들고 있던 큐 계속).
}

export enum TaskStatus {
  DRAFT     = 'DRAFT',     // 등록만 된 상태 — 자동 할당 대상 아님 (관제가 수동 할당)
  PENDING   = 'PENDING',
  ASSIGNED  = 'ASSIGNED',
  RUNNING   = 'RUNNING',
  SUSPENDED = 'SUSPENDED', // 관제 조치 대기 (다이어그램의 AlertTower 상태)
  COMPLETED = 'COMPLETED',
  FAILED    = 'FAILED',    // 완전히 복구 불가능한 실패
}

export type TaskHistoryDocument = HydratedDocument<TaskHistory>;

/**
 * ROS 출력 한 스텝 — 미리 계산해 태스크에 저장되는 한 동작 단위.
 *  - kind: 'move'(노드 주행) | 'service'(서비스 호출) | 'topic'(토픽 발행) | 'wait'(대기) | 'supply'(비전 적재)
 *  - service/topic은 topicName/messageType/message를 (서비스명/타입/요청) 또는 (토픽/타입/메시지)로 재사용.
 *  - 완료조건: move=노드 도착 / service=응답 / topic=즉시 / wait=시간 / supply=is_loaded.
 * awaitKind는 move 호환용('arrival' | 'vision_loaded' | 'none').
 */
@Schema({ _id: false })
export class RosStep {
  /** 스텝 종류 (위 kind). 미지정(구버전)이면 awaitKind로 move/supply 추론. */
  @Prop({ type: String, default: 'move' })
  kind: string;

  @Prop({ required: true })
  topicName: string;       // move=goal_pose 토픽 / service=서비스명 / topic=토픽명

  @Prop({ type: String, default: '' })
  messageType: string;     // service=서비스타입 / topic=메시지타입 / wait=빈값(메시지 없음)

  @Prop({ type: Object, default: {} })
  message: Record<string, unknown>; // service=요청(request) / topic=메시지 / move=goal_pose

  /** 이 스텝의 완료조건이 '노드 도착'일 때 대상 노드 id (그 외 null) */
  @Prop({ type: String, default: null })
  awaitNodeId: string | null;

  /** 'arrival' | 'vision_loaded' | 'none' | 'signal' (move/supply/wait 완료조건) */
  @Prop({ type: String, default: 'arrival' })
  awaitKind: string;

  /** wait 스텝의 대기 시간(ms) */
  @Prop({ type: Number, default: 0 })
  waitMs: number;

  // ── 신호 기반 완료(awaitKind='signal') — 특정 ROS 토픽 신호가 오면 스텝 완료(=다음 실행/태스크 성공) ──
  /** 완료 신호를 수신할 토픽. `{robot}` 토큰은 실행 시 실제 로봇으로 치환. */
  @Prop({ type: String, default: '' })
  awaitTopic: string;
  /** 메시지에서 비교할 필드(dot-path, 예: 'data' / 'status.code'). 빈값 = 메시지 수신만으로 완료. */
  @Prop({ type: String, default: '' })
  awaitField: string;
  /** 기대값. null = 필드 truthy(또는 메시지 존재)만으로 완료. */
  @Prop({ type: Object, default: null })
  awaitValue: unknown;

  // ── 엔드(완료) 조건 — 종류 무관 공통. 스텝의 기본 완료(도착/응답/result/발행) 후, 이 외부 신호가
  //    와야 다음 스텝으로 진행한다. 비어 있으면 기본 완료 즉시 진행. (service/action 결과값 조건과 별개) ──
  /** 엔드조건 신호 토픽. `{robot}` 토큰은 실행 시 실제 로봇으로 치환. 빈값 = 엔드조건 없음. */
  @Prop({ type: String, default: '' })
  endTopic: string;
  /** 엔드조건 비교 필드(dot-path). 빈값 = 메시지 수신만으로 충족. */
  @Prop({ type: String, default: '' })
  endField: string;
  /** 엔드조건 기대값. null = 필드 truthy(또는 메시지 존재)만으로 충족. */
  @Prop({ type: Object, default: null })
  endValue: unknown;
}
export const RosStepSchema = SchemaFactory.createForClass(RosStep);

/**
 * TaskHistory — 실행/이력 레코드. 배차된 순간부터 완료/실패까지의 "한 번의 실행"을 담는다.
 *  (구 Task. 컬렉션 fms_tasks 유지 — 기존 데이터·소켓 이벤트('fms_tasks') 호환.)
 *  재사용 가능한 '정의'는 별도 Task/TaskSequence(task-catalog/task-catalog.schema.ts)에 저장.
 */
@Schema({ timestamps: true, collection: 'fms_tasks' })
export class TaskHistory {
  @Prop({ required: true, unique: true, index: true })
  task_id: string;

  /** 표시용 이름 — 빌더 커스텀 태스크는 정의 이름, 기본 유형 태스크는 빈값(유형명으로 표시). */
  @Prop({ type: String, default: '' })
  label: string;

  @Prop({ required: true, enum: TaskType })
  type: TaskType;

  @Prop({ required: true, enum: TaskStatus, default: TaskStatus.PENDING, index: true })
  status: TaskStatus;

  /** MOVE/PROCESS = 목적지 노드 / SUPPLY = 보급 품목("물"/"약") / CHARGE = 미선택(충전소 배차는 추후) */
  @Prop({ required: false, default: '' })
  targetNode: string;

  /** 1=긴급 … 5=보통 … 10=낮음 */
  @Prop({ default: 5, index: true })
  priority: number;

  /** 연속(batch) 내 순번 — 같은 로봇 큐에서 작을수록 먼저 실행. 단건은 0. */
  @Prop({ type: Number, default: 0, index: true })
  seq: number;

  /** 연속 식별자 — 같은 batchId 끼리 UI에서 하나의 카드로 묶임. 단건은 null. */
  @Prop({ type: String, default: null, index: true })
  batchId: string | null;

  /** 시나리오 식별자 — 같은 scenarioId 끼리 seq 순서로 (로봇이 달라도) 순차 실행. 한 스텝 완료 시 다음 스텝 dispatch. 단건/연속은 null. */
  @Prop({ type: String, default: null, index: true })
  scenarioId: string | null;

  /** 반복 수행 — true면 연속 한 사이클 완료 후 자동으로 PENDING 리셋·재시작(정지 명령 전까지). */
  @Prop({ type: Boolean, default: false })
  repeat: boolean;

  @Prop()
  waitReason?: string;

  // 객체 형태를 버리고 로봇 ID만 매핑하여 Single Source of Truth 유지
  @Prop({ type: String, default: null, index: true })
  assignedRobotId: string | null;

  /** 특정 로봇에게 배정 요청 (null = 임의 배정) */
  @Prop({ type: String, default: null })
  preferredRobotId: string | null;

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

  /** dispatch 시 미리 계산해 저장하는 ROS 출력 시퀀스 (유형별 토픽 계획). 완료마다 다음 스텝 전송. */
  @Prop({ type: [RosStepSchema], default: [] })
  rosPlan: RosStep[];

  /** 현재 실행 중인 rosPlan 인덱스 (도착/완료 시 ++) */
  @Prop({ type: Number, default: 0 })
  rosCursor: number;
}

export const TaskHistorySchema = SchemaFactory.createForClass(TaskHistory);