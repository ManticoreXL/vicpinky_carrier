export const ROBOT_STATUS_KO: Record<string, string> = {
  // 공통
  IDLE:         '대기',
  RETURNING:    '복귀 중',
  PAUSED:       '일시정지',
  ERROR:        '오류',
  OFFLINE:      '오프라인',
  // 이동·작업 (이동·구호·공급 통합 — 구체 작업은 활성 태스크에서 표시)
  WORKING:      '작업 중',
  TO_CHARGE:    '충전소 이동 중',
  CHARGING:     '충전 중',
  WAITING_CHARGE: '충전 대기',
  // 빅핑키 캐리어
  PARKED:       '주차됨',
  TO_LOAD:      '적재 위치 이동 중',
  LOADING:      '상차 중',
  LOADED:       '적재됨',
  UNLOADING:    '하차 중',
  CARRIER_UP:   '캐리어 올림',
  CARRIER_DOWN: '캐리어 내림',
};

export const TASK_STATUS_KO: Record<string, string> = {
  DRAFT:     '등록됨',
  PENDING:   '대기 중',
  ASSIGNED:  '배정됨',
  RUNNING:   '진행 중',
  COMPLETED: '완료',
  FAILED:    '실패',
  SUSPENDED: '일시정지',
};

export const TASK_TYPE_KO: Record<string, string> = {
  SUPPLY:      '공급',
  PROCESS:     '구호',
  CHARGE:      '충전',
  MOVE:        '이동',
  RECALL:      '복귀',
  PAUSE:       '일시정지',
  DISTRIBUTE:  '배포',
  SIMPLE_MOVE: '이동',
};

// 활성(진행 중 — 새 태스크 배정 불가) / 가용(배정 가능) 상태 분류
export const ACTIVE_STATUSES = new Set<string>([
  "WORKING", "TO_CHARGE", "CHARGING", "WAITING_CHARGE", "RETURNING",
  "TO_LOAD", "LOADING", "UNLOADING", "CARRIER_UP", "CARRIER_DOWN",
]);
export const AVAILABLE_STATUSES = new Set<string>(["IDLE", "PARKED", "LOADED"]);

/** 온라인 여부 — 백엔드 status 기준(OFFLINE이 아니면 온라인). 프론트는 타이머로 추정하지 않는다. */
export const isRobotOnline = (status?: string | null): boolean => status != null && status !== "OFFLINE";

export function robotStatusKo(status?: string | null): string {
  if (!status) return '알 수 없음';
  return ROBOT_STATUS_KO[status] ?? status;
}

// 상태 → 텍스트 색 (그룹 기반: 가용=녹색, 활성=주황, 보류=주황, 오류=적, 오프라인=흐림)
export function robotStatusColor(status?: string | null): string {
  if (!status || status === 'OFFLINE') return 'text-white/[0.45]';
  if (status === 'ERROR') return 'text-rose-600';
  if (AVAILABLE_STATUSES.has(status)) return 'text-emerald-600';
  return 'text-amber-600';
}

// 상태 → 도트 색 (online=false면 흐림)
export function robotStatusDot(status?: string | null, online = true): string {
  if (!online || !status || status === 'OFFLINE') return 'bg-white/15';
  if (status === 'ERROR') return 'bg-rose-500';
  if (AVAILABLE_STATUSES.has(status)) return 'bg-emerald-400';
  if (status === 'PAUSED') return 'bg-amber-400';
  return 'bg-amber-500 animate-pulse';
}

export function taskTypeKo(type?: string | null): string {
  if (!type) return '—';
  return TASK_TYPE_KO[type] ?? type;
}

export function taskStatusKo(status?: string | null): string {
  if (!status) return '—';
  return TASK_STATUS_KO[status] ?? status;
}
