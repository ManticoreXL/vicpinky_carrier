// 로봇 추천 랭킹 — 백엔드(robot-priority.ts)가 단일 계산. 프론트는 조회/표시만 한다.
// GET /api/fms/robot-ranking?targetNode=&type= → RankedRobot[] (online·busy·battery·distance·rank).
// (이전 utils/robotScore.ts 의 클라이언트 점수화는 백엔드와 임계값·거리계산이 갈려 제거됨.)
import { BACKEND_URL } from "../config";

export type RankedRobot = {
  robotId: string;
  rank: number;
  online: boolean;
  busy: boolean;
  error?: boolean;
  batteryPct: number | null;
  distance: number | null;   // 목적지까지 A* 거리(m) — 백엔드 계산. 목적지 없으면 null
  node?: string | null;      // 현재 최근접 노드(표시용)
  kind?: string;
};

export async function fetchRobotRanking(targetNode: string, type: string): Promise<RankedRobot[]> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/fms/robot-ranking?targetNode=${encodeURIComponent(targetNode)}&type=${encodeURIComponent(type)}`);
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
