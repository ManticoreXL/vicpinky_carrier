// FMS 순수 헬퍼
// (기하 변환은 src/geometry/pose.ts의 Quaternion/Pose/normalizeAngle 로 이동)
import { RobotCache } from './task-manager.types';

/** RobotCache 기본값 (lastSeen만 지정) */
export function emptyCache(lastSeen: number): RobotCache {
  return { lastSeen, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
}
