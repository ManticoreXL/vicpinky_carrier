// 좌표 변환 / 기하 유틸 (순수 함수)
import type { StaticMapInfo } from "./types";

export function worldToCanvas(wx: number, wy: number, info: StaticMapInfo, scale: number) {
  const col = (wx - info.originX) / info.resolution;
  const row = (info.height - 1) - (wy - info.originY) / info.resolution;
  return { cx: col * scale, cy: row * scale };
}

export function canvasToWorld(cx: number, cy: number, info: StaticMapInfo, scale: number) {
  const col = cx / scale;
  const row = cy / scale;
  return {
    wx: info.originX + col * info.resolution,
    wy: info.originY + (info.height - 1 - row) * info.resolution,
  };
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const l2 = (x2 - x1)**2 + (y2 - y1)**2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

export function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}
