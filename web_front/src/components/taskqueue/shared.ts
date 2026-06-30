import type { ReactNode } from "react";

// 글로벌 태스크 큐 공용 타입·상수·표시 헬퍼 (서브컴포넌트들이 공유).

export type FNode = { node_id: string; map_id: string; type: string };
export const TYPES = ["MOVE", "PROCESS", "CHARGE", "SUPPLY", "RECALL", "PAUSE"] as const;
// 연속(한 로봇 순차 수행) — 노드 목적지형(이동/구호) + 복귀(목적지=현재 맵 초기위치)
export const BATCH_TYPES = ["MOVE", "PROCESS", "RECALL"] as const;
// 시나리오(로봇 무관 단건 순차) — 작업형 유형 + 복귀. 스텝마다 로봇 지정.
export const SCENARIO_TYPES = ["MOVE", "PROCESS", "SUPPLY", "CHARGE", "RECALL"] as const;
export const SUPPLY_ITEMS = ["물", "약"];

// 유형 배지 — 진한 색(고대비)
export const TYPE_COLOR: Record<string, string> = {
  MOVE:    "bg-sky-500 text-white",
  PROCESS: "bg-rose-500 text-white",
  CHARGE:  "bg-emerald-500 text-white",
  SUPPLY:  "bg-violet-500 text-white",
  RECALL:  "bg-amber-500 text-white",
  PAUSE:   "bg-pink-500 text-white",
};
export const statusPill = (s: string) =>
  s === "RUNNING" ? "bg-emerald-500/30 text-emerald-50" : s === "ASSIGNED" ? "bg-sky-500/30 text-sky-50" :
  s === "FAILED" ? "bg-rose-500/30 text-rose-50" : s === "COMPLETED" ? "bg-white/15 text-white/80" :
  s === "DRAFT" ? "bg-violet-500/30 text-violet-50" : "bg-amber-400 text-black";
export const statusDot = (s: string) =>
  s === "RUNNING" ? "bg-emerald-400 animate-pulse" : s === "ASSIGNED" ? "bg-sky-400" :
  s === "FAILED" ? "bg-rose-500" : s === "COMPLETED" ? "bg-white/25" :
  s === "DRAFT" ? "bg-violet-400" : "bg-amber-800";
export const cardBorder = (s: string) =>
  s === "RUNNING" ? "border-emerald-500/40" : s === "FAILED" ? "border-rose-500/30" :
  s === "ASSIGNED" ? "border-sky-500/30" : "border-white/[0.1]";

// 커스텀 Dropdown 버튼 공통 스타일 — 카드와 동일 톤(bg-white/[0.05]).
export const INP = "bg-white/[0.05] border border-white/[0.1] rounded-lg px-2 py-1 text-[11px] text-white/85 focus:outline-none focus:border-white/[0.2]";

// 로봇 종류별 아이콘 (id 패턴으로 자동 판별)
export function robotIcon(id: string): string {
  if (!id) return "🤖";
  if (id === "omx" || /arm/i.test(id)) return "🦾";          // 로봇팔
  if (id === "vicpinky" || /pinky/i.test(id)) return "📦";   // 캐리어
  if (/^tb3/i.test(id)) return "🐢";                          // 터틀봇
  if (/^TEST-?BOT/i.test(id)) return "🧪";                    // 테스트봇
  return "🤖";
}

// 등록 일시 표기/필터 (로컬 기준)
export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd} ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
};
export const ymdLocal = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Date → datetime-local 입력값(YYYY-MM-DDTHH:mm, 로컬시각)
export const toLocalDatetimeValue = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export type Opt = { value: string; label: ReactNode; selectedLabel?: ReactNode; disabled?: boolean };

// 유형 색 점(리스트 표시용)
export const TYPE_DOT: Record<string, string> = { MOVE: "bg-sky-500", PROCESS: "bg-rose-500", CHARGE: "bg-emerald-500", SUPPLY: "bg-violet-500", RECALL: "bg-amber-500", PAUSE: "bg-pink-500" };
