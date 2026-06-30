// AdminView 공통 스타일 / 색상 토큰
import type { RobotStatus, TaskStatus, TaskType } from "./types";

export const TH = "px-3 py-2 text-left text-xs font-bold tracking-wide text-white/[0.68] whitespace-nowrap";
export const TD = "px-3 py-2 text-xs text-white/90 whitespace-nowrap";
export const INP = "bg-[#FFCE99]/32 border border-white/[0.1] rounded px-2 py-1 text-xs text-white/90 w-full focus:outline-none focus:border-white/[0.1]";
export const SEL = `${INP} cursor-pointer`;
export const BTN = (color: string) =>
  `px-2 py-0.5 text-xs font-bold tracking-wider rounded border transition-colors ${color}`;

export const STATUS_COLOR: Record<RobotStatus, string> = {
  // 가용
  IDLE: "text-emerald-600", PARKED: "text-emerald-600", LOADED: "text-emerald-600",
  // 활성
  WORKING: "text-amber-600", TO_CHARGE: "text-amber-600", CHARGING: "text-amber-600", WAITING_CHARGE: "text-amber-600",
  RETURNING: "text-amber-600", TO_LOAD: "text-amber-600", LOADING: "text-amber-600", UNLOADING: "text-amber-600",
  CARRIER_UP: "text-amber-600", CARRIER_DOWN: "text-amber-600",
  // 보류/오류/오프라인
  PAUSED: "text-amber-600",
  ERROR: "text-rose-600",
  OFFLINE: "text-white/[0.68]",
};

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  DRAFT: "text-violet-500",
  PENDING: "text-white/90",
  ASSIGNED: "text-sky-500",
  RUNNING: "text-emerald-600",
  SUSPENDED: "text-amber-600",
  COMPLETED: "text-white/[0.68]",
  FAILED: "text-rose-600",
};

export const TASK_TYPE_COLOR: Record<TaskType, string> = {
  SUPPLY: "bg-blue-900/40 text-white/[0.82] border-white/[0.1]",
  PROCESS: "bg-yellow-900/40 text-white/[0.82] border-white/[0.1]",
  CHARGE: "bg-green-900/40 text-white/[0.82] border-white/[0.1]",
  MOVE: "bg-purple-900/40 text-white/[0.82] border-white/[0.1]",
};
