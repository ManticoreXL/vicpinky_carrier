// 쿼터니언·각도 변환 + 표시 포맷 — 로봇 패널/navmap 공용 순수 유틸.
// (이전에 BigPinky/Turtlebot/PinkyBot 패널과 navmap/geometry 에 4중복돼 있던 것을 통합.)

export interface Quat { x: number; y: number; z: number; w: number }

/** 쿼터니언 → yaw(라디안, Z축 회전) */
export function quatToYaw(q: Quat): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

/** 쿼터니언 → roll(라디안, X축 회전) */
export function quatToRoll(q: Quat): number {
  return Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
}

/** 쿼터니언 → pitch(라디안, Y축 회전) */
export function quatToPitch(q: Quat): number {
  return Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
}

/** 라디안 → 도 */
export const r2d = (r: number): number => (r * 180) / Math.PI;

/** 숫자 → 고정소수 문자열 */
export const f = (n: number, d = 2): string => n.toFixed(d);
