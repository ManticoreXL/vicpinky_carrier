import { TaskType } from './task.schema';

// ─────────────────────────────────────────────────────────────────────────────
//  ★ "주어진 작업에 대한 로봇 우선순위" — 이 파일에서 규칙을 관리합니다.
//
//  모든 유형(이동/구호/충전/공급) 공통 규칙(앞에 올수록 우선):
//   1) 제외:   오프라인·오류(ERROR)·일시정지(PAUSED) 로봇은 후보에서 아예 뺀다.
//   2) 큐 개수: 로봇이 가진 태스크 큐(대기+수행중)가 적은 순.
//   3) 배터리:  많은 순(높을수록 먼저, 미상은 최하위).
//   4) 거리:    목적지에 가까운 순(거리 미상은 최하위).
//  ※ 복귀(RECALL)·일시정지(PAUSE)는 지정 로봇 전용이라 이 랭킹을 타지 않는다(호출부에서 직접 실행).
// ─────────────────────────────────────────────────────────────────────────────

/** 순위 매길 로봇 후보 — 호출부(글로벌 태스크 큐)가 RobotState/큐/토폴로지에서 채워 넘긴다. */
export interface RobotCandidate {
  robotId: string;
  online: boolean;                 // 온라인 여부 — false면 후보 제외
  error?: boolean;                 // 오류(ERROR) — true면 후보 제외(UI 비활성)
  paused?: boolean;                // 일시정지(PAUSED) — true면 후보 제외
  busy: boolean;                   // 현재 수행 중(active 보유) — 카드 표시용("작업 중")
  queueLen: number;                // 로봇 큐 깊이(대기 PENDING + 수행중) — 적을수록 우선(2순위)
  batteryPct: number | null;       // 배터리 % — 많을수록 우선(3순위)
  kind?: string;                   // 로봇 종류(tb3 / omx / vicpinky / test 등)
  node?: string | null;            // 현재 위치(최근접 노드) — 카드 표시용
  distance?: number | null;        // 현재 위치 노드 → 목적지 거리(m) — 가까울수록 우선(4순위). 없으면 최하위.
}

/** 순위 매길 작업(태스크) 정보 — 필요한 필드만. (현재 비교엔 쓰지 않으나 API 호환 유지) */
export interface ScorableTaskForRobot {
  type?: TaskType | string;
  targetNode?: string;
}

export interface RankedRobot extends RobotCandidate {
  rank: number;                    // 1 = 가장 우선
}

/**
 * 우선순위 비교자 — 반환값이 음수면 a가 앞(우선). 모든 유형 동일 규칙.
 *  2) 큐 개수 적은 순  3) 배터리 많은 순  4) 목적지 가까운 순.
 *  (1순위 = 오프라인·오류·일시정지 제외는 rankRobotsForTask 필터에서 처리)
 */
export function compareRobotForTask(a: RobotCandidate, b: RobotCandidate): number {
  // 2순위: 로봇 큐 개수 적은 순
  if (a.queueLen !== b.queueLen) return a.queueLen - b.queueLen;
  // 3순위: 배터리 많은 순 (미상은 -1로 최하위)
  const ab = a.batteryPct ?? -1;
  const bb = b.batteryPct ?? -1;
  if (ab !== bb) return bb - ab;
  // 4순위: 목적지에 가까운 순 (거리 미상은 최하위)
  const da = a.distance ?? Number.POSITIVE_INFINITY;
  const db = b.distance ?? Number.POSITIVE_INFINITY;
  return da - db;
}

/** 후보 로봇들을 우선순위대로 정렬해 반환(rank 부여). 오프라인·오류·일시정지는 후보에서 제외. */
export function rankRobotsForTask(candidates: RobotCandidate[]): RankedRobot[] {
  return candidates
    .filter((r) => r.online && !r.error && !r.paused) // 1순위: 접속 끊김·오류·일시정지 제외
    .sort(compareRobotForTask)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
