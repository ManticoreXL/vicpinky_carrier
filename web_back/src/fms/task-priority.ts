import { TaskStatus, TaskType } from './task.schema';

// ─────────────────────────────────────────────────────────────────────────────
//  ★ "우선순위별" 정렬 = 1순위 상태 → 2순위 업무 유형 우선순위. 이 파일만 고치면 됩니다.
// ─────────────────────────────────────────────────────────────────────────────

// 1순위: 태스크 상태 (점수 높을수록 위) — 등록됨 → 배정됨 → 수행중 → 완료 → 실패
const STATUS_RANK: Record<string, number> = {
  [TaskStatus.DRAFT]:     5, // 등록됨
  [TaskStatus.PENDING]:   4, // 배정됨(로봇 지정·할당 대기)
  [TaskStatus.ASSIGNED]:  4, // 배정됨
  [TaskStatus.RUNNING]:   3, // 수행중
  [TaskStatus.SUSPENDED]: 3, // 수행중 계열
  [TaskStatus.COMPLETED]: 2, // 완료
  [TaskStatus.FAILED]:    1, // 실패
};

// 2순위: 업무 유형별 우선순위 (숫자 클수록 우선 — 같은 상태 안에서 위로)
const TYPE_PRIORITY: Record<string, number> = {
  [TaskType.CHARGE]:  1,  // 충전
  [TaskType.MOVE]:    5,  // 이동
  [TaskType.SUPPLY]:  5,  // 공급
  [TaskType.PROCESS]: 10, // 구호
  [TaskType.RECALL]:  20, // 복귀 — 최상위
  [TaskType.PAUSE]:   20, // 일시정지 — 즉시 처리(긴급)
};

export interface ScorableTask {
  status?: TaskStatus | string;
  type?:   TaskType | string;
}

const statusRank   = (t: ScorableTask) => STATUS_RANK[t.status as string] ?? 0;
const typePriority = (t: ScorableTask) => TYPE_PRIORITY[t.type as string] ?? 0;

/** 우선순위별 비교자: 상태(높은 순) → 같은 상태면 유형 우선순위(높은 순 — 숫자 클수록 위). */
export function compareTaskPriority(a: ScorableTask, b: ScorableTask): number {
  return statusRank(b) - statusRank(a) || typePriority(b) - typePriority(a);
}

/** 태스크 목록을 우선순위(상태→유형) 순으로 정렬(in-place)해 반환. 점수와 정렬을 한 파일에서 관리. */
export function sortByPriority<T extends ScorableTask>(tasks: T[]): T[] {
  return tasks.sort(compareTaskPriority);
}

/**
 * 교차점 양보(트래픽) 우선순위 — CollisionAvoidanceService는 "값이 작을수록 먼저 통과" 규약을
 * 쓰므로, 큐 정렬과 동일한 TYPE_PRIORITY(클수록 중요)를 부호 반전해 그 규약에 맞춘다.
 * 트래픽 우선권을 큐 정렬과 같은 단일 출처(TYPE_PRIORITY)로 통일하기 위한 매핑.
 * → 복귀·일시정지(-20) < 구호(-10) < 이동·공급(-5) < 충전(-1) < 미상(0) 순으로 우선권 확보.
 */
export function trafficPriority(t: ScorableTask): number {
  return -typePriority(t);
}
