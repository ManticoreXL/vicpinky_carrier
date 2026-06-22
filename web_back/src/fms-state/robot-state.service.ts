import { Injectable } from '@nestjs/common';
import { RobotCache } from '../fms-shared/task-manager.types';
import { emptyCache } from '../fms-shared/task-manager.helpers';

/**
 * 로봇별 실시간 상태(인메모리) 단일 소유자.
 *
 * - cache:       robotId → ROS 상태 캐시(배터리/AMCL 위치/yaw/lastSeen/amclSuspended)
 * - home:        robotId → 홈 위치 (복귀용)
 * - onlineState: robotId → 온라인 여부 (undefined = 미확인)
 *
 * DB(RobotService)와 별개로, tick 주기로 갱신되는 휘발성 상태를 모은다.
 */
@Injectable()
export class RobotStateService {
  private readonly cacheMap   = new Map<string, RobotCache>();
  private readonly homeMap    = new Map<string, { x: number; y: number; yaw: number }>();
  private readonly onlineMap  = new Map<string, boolean>();

  // ── ROS 상태 캐시 ──────────────────────────────────────────────────────────

  getCache(robotId: string): RobotCache | undefined {
    return this.cacheMap.get(robotId);
  }

  /** 기존 캐시에 patch 병합(없으면 emptyCache 기반 생성) */
  patchCache(robotId: string, patch: Partial<RobotCache>, now = Date.now()): RobotCache {
    const prev = this.cacheMap.get(robotId) ?? emptyCache(now);
    const next = { ...prev, ...patch };
    this.cacheMap.set(robotId, next);
    return next;
  }

  setCache(robotId: string, cache: RobotCache): void {
    this.cacheMap.set(robotId, cache);
  }

  entries(): IterableIterator<[string, RobotCache]> {
    return this.cacheMap.entries();
  }

  // ── 홈 위치 ────────────────────────────────────────────────────────────────

  setHome(robotId: string, x: number, y: number, yaw: number): void {
    this.homeMap.set(robotId, { x, y, yaw });
  }

  getHome(robotId: string): { x: number; y: number; yaw: number } | undefined {
    return this.homeMap.get(robotId);
  }

  // ── 온라인 상태 ────────────────────────────────────────────────────────────

  getOnlineState(robotId: string): boolean | undefined {
    return this.onlineMap.get(robotId);
  }

  setOnlineState(robotId: string, online: boolean): void {
    this.onlineMap.set(robotId, online);
  }
}
