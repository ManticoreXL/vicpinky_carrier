// TaskManagerView 헬퍼
import type { RosMessage } from "../../hooks/useNestSocket";
import { robotStatusKo } from "../../utils/statusLabel";
import { ONLINE_MS } from "./constants";
import type { TopoNode } from "./types";

export function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
  const topic = robotId === "omx" ? `/${robotId}/joint_states` : `/${robotId}/odom`;
  const msg = rosMessages[topic];
  return !!msg && Date.now() - msg.timestamp < ONLINE_MS;
}

export function uid() { return Math.random().toString(36).slice(2, 9); }

// 로봇 상태 → 도트/라벨/텍스트 색 (오프라인 우선). RobotMonitorCard 전용.
export function robotVisual(online: boolean, status?: string): { dot: string; label: string; color: string } {
  if (!online) return { dot: "bg-[#521C0D]/40", label: "오프라인", color: "text-slate-500" };
  switch (status) {
    case "MOVING": case "WORKING": case "CHARGING":
      return { dot: "bg-amber-400 animate-pulse", label: robotStatusKo(status), color: "text-amber-600" };
    case "ERROR":
      return { dot: "bg-rose-500 animate-pulse", label: robotStatusKo(status), color: "text-rose-600" };
    case "IDLE":
    default:
      return { dot: "bg-emerald-400", label: robotStatusKo(status ?? "IDLE"), color: "text-emerald-600" };
  }
}

export function computeNearest(x: number, y: number, nodes: TopoNode[]): string | null {
  if (!nodes.length) return null;
  let best = nodes[0], bestDist = Math.hypot(best.x - x, best.y - y);
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best.node_id;
}
