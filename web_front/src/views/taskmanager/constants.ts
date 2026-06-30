// TaskManagerView 상수
export { ROBOTS } from "../../robots"; // 로봇 로스터는 src/robots.ts 에 단일 정의(여기선 재노출만)

export const TASK_COLORS: Record<string, string> = {
  SUPPLY:  "bg-sky-500/10 border-sky-500/30 text-sky-700",
  PROCESS: "bg-violet-500/10 border-violet-500/30 text-violet-700",
  CHARGE:  "bg-emerald-500/10 border-emerald-500/30 text-emerald-700",
  MOVE:    "bg-[#FFCE99]/32 border-white/[0.12] text-white/[0.68]",
};

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
