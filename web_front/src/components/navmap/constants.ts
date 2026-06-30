// NavMapCanvas 렌더링 상수

export const TB3_ROBOTS = [
  { id: "tb3_01", label: "TB3-01", color: "#3b82f6" },
  { id: "tb3_02", label: "TB3-02", color: "#10b981" },
  { id: "tb3_03", label: "TB3-03", color: "#f59e0b" },
  { id: "tb3_04", label: "TB3-04", color: "#8b5cf6" },
] as const;

// 지도에서 초기위치(원점)/홈/맵 지정 대상으로 선택 가능한 로봇.
// TB3 + rosbridge 미경유 가상 테스트봇(TEST-BOT). 마커/카메라 렌더링은 TB3_ROBOTS만 사용.
export const SELECTABLE_ROBOTS = [
  ...TB3_ROBOTS,
  { id: "TEST-BOT1", label: "TEST1", color: "#22d3ee" },
  { id: "TEST-BOT2", label: "TEST2", color: "#06b6d4" },
  { id: "TEST-BOT3", label: "TEST3", color: "#0ea5e9" },
  { id: "TEST-BOT4", label: "TEST4", color: "#14b8a6" },
] as const;

export const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION: "#fbbf24",
  CHARGER: "#4ade80",
  VICTIM: "#ef4444", // 조난자 임시노드 — 빨강
};

export const ROBOT_COLORS = ["#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#38bdf8"];
// 충전 임무 경로 전용 색 (충전소 노드와 동일 계열 녹색 — 일반 주행 경로와 구분)
export const CHARGE_PATH_COLOR = "#22c55e";
