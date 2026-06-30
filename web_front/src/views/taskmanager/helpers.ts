// TaskManagerView 헬퍼
import { robotStatusKo, ACTIVE_STATUSES, isRobotOnline } from "../../utils/statusLabel";
import type { TopoNode } from "./types";

// 온라인은 백엔드 status 단일 출처. (이전: ROS 토픽 타임스탬프 타이머)
export function isOnline(robotStatuses: Record<string, string>, robotId: string): boolean {
  return isRobotOnline(robotStatuses[robotId]);
}

// 로봇 상태 → 도트/라벨/텍스트 색 (오프라인 우선). RobotMonitorCard 전용.
export function robotVisual(online: boolean, status?: string): { dot: string; label: string; color: string } {
  if (!online) return { dot: "bg-[#521C0D]/40", label: "오프라인", color: "text-slate-500" };
  if (status === "ERROR")  return { dot: "bg-rose-500 animate-pulse", label: robotStatusKo(status), color: "text-rose-600" };
  if (status === "PAUSED") return { dot: "bg-amber-400", label: robotStatusKo(status), color: "text-amber-600" };
  if (status && ACTIVE_STATUSES.has(status))
    return { dot: "bg-amber-400 animate-pulse", label: robotStatusKo(status), color: "text-amber-600" };
  // IDLE / PARKED / LOADED / 기타 → 가용(녹색)
  return { dot: "bg-emerald-400", label: robotStatusKo(status ?? "IDLE"), color: "text-emerald-600" };
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
