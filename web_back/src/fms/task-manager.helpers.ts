// TaskManagerService 순수 헬퍼
import { RobotCache } from './task-manager.types';

/** 각도를 [-π, π] 범위로 정규화 */
export function normalizeAngle(a: number): number {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 쿼터니언 → yaw(라디안) */
export function quatToYaw(ori: { x?: number; y?: number; z?: number; w?: number }): number {
  return Math.atan2(
    2 * ((ori.w ?? 1) * (ori.z ?? 0) + (ori.x ?? 0) * (ori.y ?? 0)),
    1 - 2 * ((ori.y ?? 0) ** 2 + (ori.z ?? 0) ** 2),
  );
}

/** RobotCache 기본값 (lastSeen만 지정) */
export function emptyCache(lastSeen: number): RobotCache {
  return { lastSeen, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
}
