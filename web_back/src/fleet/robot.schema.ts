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

  // 💡 여기에 type: String을 명시하여 NestJS(Mongoose)가 타입을 헷갈리지 않게 해줍니다.
  @Prop({ type: String, default: null })
  location: string | null; // 현재 위치한 node_id

  /** 오프라인이 될 때 마지막으로 위치했던 노드 ID를 기록 (복구/추적용) */
  @Prop({ type: String, default: null })
  lastNode: string | null;

  @Prop({ required: true })
  ip: string;

  @Prop({ required: true })
  ros_domain_id: number;

  // ── 실시간 텔레메트리 (ROS 토픽 변경 시 TelemetryService가 즉시 반영) ──────
  /** map 프레임 기준 현재 위치 X (amcl_pose 우선, odom 폴백) */
  @Prop({ type: Number, default: null })
  pose_x: number | null;

  /** map 프레임 기준 현재 위치 Y */
  @Prop({ type: Number, default: null })
  pose_y: number | null;

  /** 현재 헤딩(rad) */
  @Prop({ type: Number, default: null })
  yaw: number | null;

  /** 배터리 잔량 (0~100%) */
  @Prop({ type: Number, default: null })
  battery: number | null;

  /** 마지막 토픽 수신 시각 — 온라인 판정/디버깅용 */
  @Prop({ type: Date, default: null })
  lastSeenAt: Date | null;
}

export const RobotSchema = SchemaFactory.createForClass(Robot);