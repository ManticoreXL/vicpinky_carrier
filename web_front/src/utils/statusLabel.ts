export const ROBOT_STATUS_KO: Record<string, string> = {
  IDLE:     '대기',
  MOVING:   '이동 중',
  WORKING:  '작업 중',
  CHARGING: '충전 중',
  ERROR:    '오류',
  OFFLINE:  '오프라인',
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
  DISTRIBUTE:  '배포',
  SIMPLE_MOVE: '이동',
};

export function robotStatusKo(status?: string | null): string {
  if (!status) return '알 수 없음';
  return ROBOT_STATUS_KO[status] ?? status;
}

export function taskTypeKo(type?: string | null): string {
  if (!type) return '—';
  return TASK_TYPE_KO[type] ?? type;
}

export function taskStatusKo(status?: string | null): string {
  if (!status) return '—';
  return TASK_STATUS_KO[status] ?? status;
}
