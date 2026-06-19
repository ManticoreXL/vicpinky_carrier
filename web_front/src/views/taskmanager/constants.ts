// TaskManagerView 상수

export const ROBOTS = [
  { id: "vicpinky", domain: 40, type: "carrier" },
  { id: "tb3_01",   domain: 41, type: "tb3" },
  { id: "tb3_02",   domain: 42, type: "tb3" },
  { id: "tb3_03",   domain: 43, type: "tb3" },
  { id: "tb3_04",   domain: 44, type: "tb3" },
  { id: "omx",      domain: 45, type: "arm" },
] as const;

export const TASK_COLORS: Record<string, string> = {
  SUPPLY:  "bg-sky-500/10 border-sky-500/30 text-sky-700",
  PROCESS: "bg-violet-500/10 border-violet-500/30 text-violet-700",
  CHARGE:  "bg-emerald-500/10 border-emerald-500/30 text-emerald-700",
  MOVE:    "bg-[#FFCE99]/32 border-white/[0.12] text-white/[0.68]",
};

export const STATUS_DOT: Record<string, string> = {
  PENDING:   "bg-amber-400",
  ASSIGNED:  "bg-sky-400",
  RUNNING:   "bg-emerald-400 animate-pulse",
  COMPLETED: "bg-white/30",
  FAILED:    "bg-rose-400",
};

export const ONLINE_MS = 5000;

export const TOOL_LABELS: Record<string, string> = {
  dispatch_task:    "태스크 디스패치",
  cancel_task:      "태스크 취소",
  stop_robot:       "로봇 정지",
  return_home:      "홈 귀환",
  get_robots:       "로봇 상태 조회",
  get_nodes:        "노드 목록 조회",
  get_active_tasks: "활성 태스크 조회",
  lock_node:        "노드 잠금",
};
