import { useState, useEffect } from "react";
import { BACKEND_URL } from "../config";

export interface TopoNode { node_id: string; x: number; y: number; type: string; }

/**
 * 배정된(assignments) 첫 맵의 토폴로지 노드를 불러온다. (TaskManagerView·QueueTestView 공용)
 * 백엔드 재시작 중 첫 fetch가 실패할 수 있어, 노드가 채워질 때까지 재시도한다.
 * 노드 자체는 백엔드(DB) 단일 출처 — 이 훅은 조회만 한다.
 */
export function useTopoNodes(): TopoNode[] {
  const [nodes, setNodes] = useState<TopoNode[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async (tries = 10) => {
      for (let i = 0; i < tries; i++) {
        try {
          const r = await fetch(`${BACKEND_URL}/api/map/assignments`);
          if (r.ok) {
            const asgn = (await r.json()) as Record<string, string>;
            const mapId = Object.values(asgn)[0];
            if (mapId) {
              const nr = await fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${mapId}`);
              if (nr.ok && alive) setNodes(await nr.json());
              return;
            }
          }
        } catch { /* 재시도 */ }
        if (!alive) return;
        await new Promise((res) => setTimeout(res, 1200));
      }
    };
    void load();
    return () => { alive = false; };
  }, []);
  return nodes;
}
