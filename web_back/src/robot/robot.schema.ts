import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum RobotStatus {
  // ── 공통 ──
  IDLE         = 'IDLE',          // 대기
  RETURNING    = 'RETURNING',     // 복귀 중 (홈 복귀)
  PAUSED       = 'PAUSED',        // 일시정지 (AMCL 끊김 등으로 보류)
  ERROR        = 'ERROR',         // 오류 (전복 등)
  OFFLINE      = 'OFFLINE',       // 오프라인
  // ── 이동·작업 (주로 터틀봇) ──
  WORKING      = 'WORKING',       // 작업 중 (이동·구호·공급 통합 — 구체 작업은 활성 태스크에서 파생)
  TO_CHARGE    = 'TO_CHARGE',     // 충전소 이동 중 (CHARGE 주행)
  CHARGING     = 'CHARGING',      // 충전 중 (도크 접촉)
  WAITING_CHARGE = 'WAITING_CHARGE', // 충전 대기 (충전소 만석 → initPosition에서 대기)
  // ── 빅핑키 캐리어 ──
  PARKED       = 'PARKED',        // 주차됨
  TO_LOAD      = 'TO_LOAD',       // 적재 위치 이동 중
  LOADING      = 'LOADING',       // 상차 중
  LOADED       = 'LOADED',        // 적재됨
  UNLOADING    = 'UNLOADING',     // 하차 중
  CARRIER_UP   = 'CARRIER_UP',    // 캐리어 올림
  CARRIER_DOWN = 'CARRIER_DOWN',  // 캐리어 내림
}

export type RobotDocument = HydratedDocument<Robot>;

@Schema({ timestamps: true, collection: 'fleet_robots' })
export class Robot {
  @Prop({ required: true, unique: true, index: true })
  robot_id: string;

  @Prop({ required: true, enum: RobotStatus, default: RobotStatus.OFFLINE, index: true })
  status: RobotStatus;

  /** 현재 로봇이 위치한 맵 id — 초기위치 설정 시 노드(lastNode)와 함께 갱신. Fleet 맵 매칭 기준 */
  @Prop({ type: String, default: null, index: true })
  location: string | null;

  /** 로봇이 현재/마지막으로 위치한 노드 id — 주행하며 갱신, 오프라인 시 유지(복구/추적용) */
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

  /** 온라인 여부 — 백엔드가 status와 함께 권위적으로 관리(=status!==OFFLINE). 프론트는 이 값만 표시. */
  @Prop({ type: Boolean, default: false, index: true })
  online: boolean;
}

export const RobotSchema = SchemaFactory.createForClass(Robot);