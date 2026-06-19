// AdminView 공통 스타일 / 색상 토큰
import type { RobotStatus, TaskStatus, TaskType } from "./types";

export const TH = "px-3 py-2 text-left text-xs font-bold tracking-wide text-white/[0.68] whitespace-nowrap";
export const TD = "px-3 py-2 text-xs text-white/90 whitespace-nowrap";
export const INP = "bg-[#FFCE99]/32 border border-white/[0.1] rounded px-2 py-1 text-xs text-white/90 w-full focus:outline-none focus:border-white/[0.1]";
export const SEL = `${INP} cursor-pointer`;
export const BTN = (color: string) =>
  `px-2 py-0.5 text-xs font-bold tracking-wider rounded border transition-colors ${color}`;

export const STATUS_COLOR: Record<RobotStatus, string> = {
  IDLE: "text-white/90",
  MOVING: "text-white/90",
  WORKING: "text-white/90",
  ERROR: "text-white/90",
  OFFLINE: "text-white/[0.68]",
};

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  PENDING: "text-white/90",
  ASSIGNED: "text-white/90",
  RUNNING: "text-white/90",
  COMPLETED: "text-white/90",
  FAILED: "text-white/90",
};

export const TASK_TYPE_COLOR: Record<TaskType, string> = {
  SUPPLY: "bg-blue-900/40 text-white/[0.82] border-white/[0.1]",
  PROCESS: "bg-yellow-900/40 text-white/[0.82] border-white/[0.1]",
  CHARGE: "bg-green-900/40 text-white/[0.82] border-white/[0.1]",
  MOVE: "bg-purple-900/40 text-white/[0.82] border-white/[0.1]",
};
