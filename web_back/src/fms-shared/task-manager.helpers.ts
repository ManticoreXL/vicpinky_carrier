// FMS 순수 헬퍼
// (기하 변환은 src/geometry/pose.ts의 Quaternion/Pose/normalizeAngle 로 이동)
import { RobotCache } from './task-manager.types';
import { TaskStatus } from '../fms/task.schema';

/** RobotCache 기본값 (lastSeen만 지정) */
export function emptyCache(lastSeen: number): RobotCache {
  return { lastSeen, batteryPct: null, posX: null, posY: null, yaw: null, lastAmclMs: null };
}

/** 종료(완료/실패) 상태인가. `!task || isTerminalStatus(task.status)` 형태로 null 가드와 함께 쓴다. */
export function isTerminalStatus(s?: TaskStatus | null): boolean {
  return s === TaskStatus.COMPLETED || s === TaskStatus.FAILED;
}

/** dot-path 접근자 — 'a.b.c' 경로로 중첩 객체 값 추출(없으면 undefined). 신호/트리거 필드 매칭 공용. */
export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
