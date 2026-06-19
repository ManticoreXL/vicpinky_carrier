// TopologyEditor 색상 / 스타일 상수

export const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION: "#fbbf24",
  CHARGER: "#4ade80",
};

export const INP = "bg-[#FFCE99]/32 border border-white/[0.1] rounded px-2 py-1 text-xs text-white/90 w-full focus:outline-none focus:border-white/[0.08]";
export const SEL = `${INP} cursor-pointer`;
export const BTN = (c: string) => `px-2 py-1 text-xs font-bold tracking-wider rounded border transition-colors ${c}`;
