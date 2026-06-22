import { Injectable, Logger } from '@nestjs/common';

/**
 * 로봇별 task queue.
 *
 * - active: robotId → 현재 실행 중인 taskId (로봇당 1개)
 * - queued: robotId → 대기 중인 taskId[] (FIFO)
 *
 * 글로벌 큐(GlobalTaskQueueService)가 "아직 어느 로봇에도 배정되지 않은" 태스크를
 * 들고 있다면, 이 서비스는 "특정 로봇에 커밋된" 태스크의 실행/대기 순서를 책임진다.
 * 로봇이 활성 태스크를 끝내면 dispatchNext()가 이 큐에서 다음 태스크를 꺼내 실행한다.
 */
@Injectable()
export class RobotTaskQueueService {
  private readonly logger = new Logger(RobotTaskQueueService.name);

  private readonly active = new Map<string, string>();     // robotId → taskId
  private readonly queued = new Map<string, string[]>();   // robotId → taskId[]

  // ── 활성 태스크 ────────────────────────────────────────────────────────────

  getActive(robotId: string): string | undefined {
    return this.active.get(robotId);
  }

  hasActive(robotId: string): boolean {
    return this.active.has(robotId);
  }

  setActive(robotId: string, taskId: string): void {
    this.active.set(robotId, taskId);
  }

  clearActive(robotId: string): void {
    this.active.delete(robotId);
  }

  /** robotId → 활성 taskId 전체 스냅샷 순회용 */
  activeEntries(): IterableIterator<[string, string]> {
    return this.active.entries();
  }

  // ── 대기 큐 ────────────────────────────────────────────────────────────────

  /** robotId 대기열 맨 뒤에 taskId 추가 */
  enqueue(robotId: string, taskId: string): number {
    const q = this.queued.get(robotId) ?? [];
    q.push(taskId);
    this.queued.set(robotId, q);
    this.logger.log(`[로봇큐] ${robotId} 대기열 추가: ${taskId} (대기 ${q.length}개)`);
    return q.length;
  }

  /** robotId 대기열에서 다음 taskId 꺼내기 (없으면 undefined) */
  popNext(robotId: string): string | undefined {
    const q = this.queued.get(robotId);
    if (!q || q.length === 0) return undefined;
    const next = q.shift();
    if (q.length === 0) this.queued.delete(robotId);
    return next;
  }

  getQueue(robotId: string): readonly string[] {
    return this.queued.get(robotId) ?? [];
  }

  /** 특정 taskId가 이미 이 로봇 대기열(또는 활성)에 들어있는지 */
  isClaimed(taskId: string): boolean {
    for (const t of this.active.values()) if (t === taskId) return true;
    for (const q of this.queued.values()) if (q.includes(taskId)) return true;
    return false;
  }

  /** robotId의 대기 태스크 전체를 꺼내 비우기 (오프라인 시 글로벌 큐로 반환용) */
  drainQueue(robotId: string): string[] {
    const q = this.queued.get(robotId) ?? [];
    this.queued.delete(robotId);
    return q;
  }
}
