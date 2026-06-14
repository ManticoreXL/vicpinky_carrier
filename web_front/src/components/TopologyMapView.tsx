import { useState, useEffect, useRef, useCallback } from "react";
import { BACKEND_URL } from "../config";

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface MapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

interface FNode {
  node_id: string;
  map_id: string;
  type: "WAYPOINT" | "STATION" | "CHARGER";
  x: number;
  y: number;
  yaw: number;
}

interface FEdge {
  edge_id: string;
  map_id: string;
  startNode: string;
  endNode: string;
  direction: "ONE_WAY" | "BOTH_WAY";
  isLocked: boolean;
}

interface ViewState {
  scale: number;
  offX: number;
  offY: number;
  info: MapInfo;
}

// ── 좌표 변환 ─────────────────────────────────────────────────────────────────

function worldToCanvas(wx: number, wy: number, v: ViewState): [number, number] {
  const mapPx = (wx - v.info.originX) / v.info.resolution;
  const mapPy = v.info.height - (wy - v.info.originY) / v.info.resolution;
  return [mapPx * v.scale + v.offX, mapPy * v.scale + v.offY];
}

// ── 노드 색상 ─────────────────────────────────────────────────────────────────

const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION:  "#fbbf24",
  CHARGER:  "#4ade80",
};

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

interface Props {
  mapId: string;
  className?: string;
  highlightNodeId?: string | null;
}

export default function TopologyMapView({ mapId, className = "h-72", highlightNodeId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const viewRef   = useRef<ViewState | null>(null);
  const renderRef = useRef<() => void>(() => {});

  const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
  const [nodes,   setNodes]   = useState<FNode[]>([]);
  const [edges,   setEdges]   = useState<FEdge[]>([]);
  const [hover,   setHover]   = useState<FNode | null>(null);

  // ── 데이터 로드 ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapId) { setMapInfo(null); imgRef.current = null; setNodes([]); setEdges([]); return; }

    fetch(`${BACKEND_URL}/api/map/static/${mapId}/info`)
      .then(r => r.json())
      .then((info: MapInfo) => {
        setMapInfo(info);
        const img = new Image();
        img.src = `${BACKEND_URL}/api/map/static/${mapId}/image`;
        img.onload  = () => { imgRef.current = img;   renderRef.current(); };
        img.onerror = () => { imgRef.current = null; };
      })
      .catch(() => {});

    Promise.all([
      fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${mapId}`).then(r => r.json()),
      fetch(`${BACKEND_URL}/api/fleet/topology/edges?map_id=${mapId}`).then(r => r.json()),
    ]).then(([ns, es]) => {
      setNodes(ns as FNode[]);
      setEdges(es as FEdge[]);
    }).catch(() => {});
  }, [mapId]);

  // ── 캔버스 렌더 ────────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !mapInfo) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);

    const scale = Math.min(W / mapInfo.width, H / mapInfo.height) * 0.95;
    const offX  = (W - mapInfo.width  * scale) / 2;
    const offY  = (H - mapInfo.height * scale) / 2;
    const view: ViewState = { scale, offX, offY, info: mapInfo };
    viewRef.current = view;

    if (img) {
      ctx.drawImage(img, offX, offY, mapInfo.width * scale, mapInfo.height * scale);
    } else {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(offX, offY, mapInfo.width * scale, mapInfo.height * scale);
    }

    // 엣지
    edges.forEach(e => {
      const sn = nodes.find(n => n.node_id === e.startNode);
      const en = nodes.find(n => n.node_id === e.endNode);
      if (!sn || !en) return;
      const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
      const [ex, ey] = worldToCanvas(en.x, en.y, view);

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = e.isLocked ? "#6b2424" : "#4b5563";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      if (e.direction === "ONE_WAY") {
        const angle = Math.atan2(ey - sy, ex - sx);
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        const al = 8;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - al * Math.cos(angle - 0.4), my - al * Math.sin(angle - 0.4));
        ctx.lineTo(mx - al * Math.cos(angle + 0.4), my - al * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = "#4b5563";
        ctx.fill();
      }
    });

    // 노드
    nodes.forEach(n => {
      const [cx, cy] = worldToCanvas(n.x, n.y, view);
      const isHl  = n.node_id === highlightNodeId;
      const isHov = n.node_id === hover?.node_id;
      const r = isHl ? 9 : isHov ? 8 : 6;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = NODE_COLOR[n.type] ?? "#888";
      ctx.fill();

      if (isHl || isHov) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth   = 2;
        ctx.stroke();
      }

      // yaw 방향 화살표
      const yawX = cx + Math.cos(n.yaw) * (r + 5);
      const yawY = cy - Math.sin(n.yaw) * (r + 5);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(yawX, yawY);
      ctx.strokeStyle = "#ffffff88";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // 라벨
      ctx.fillStyle    = "#ffffffcc";
      ctx.font         = "bold 10px monospace";
      ctx.textAlign    = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(n.node_id, cx + r + 2, cy);
    });

    // hover 노드 툴팁 (x / y / yaw)
    if (hover) {
      const [hx, hy] = worldToCanvas(hover.x, hover.y, view);
      const lines = [
        `x   ${hover.x.toFixed(3)}`,
        `y   ${hover.y.toFixed(3)}`,
        `yaw ${hover.yaw.toFixed(3)} rad`,
      ];
      const pad = 7;
      const lh  = 14;
      const bw  = 148;
      const bh  = pad * 2 + lh * (lines.length + 1);
      let tx = hx + 14;
      let ty = hy - bh / 2;
      if (tx + bw > W) tx = hx - bw - 14;
      if (ty < 2)      ty = 2;
      if (ty + bh > H - 2) ty = H - bh - 2;

      ctx.fillStyle   = "rgba(8,8,8,0.9)";
      ctx.fillRect(tx, ty, bw, bh);
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth   = 1;
      ctx.strokeRect(tx, ty, bw, bh);

      ctx.font         = "bold 10px monospace";
      ctx.textAlign    = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle    = NODE_COLOR[hover.type] ?? "#888";
      ctx.fillText(hover.node_id, tx + pad, ty + pad);

      ctx.font      = "10px monospace";
      ctx.fillStyle = "#aaa";
      lines.forEach((line, i) => {
        ctx.fillText(line, tx + pad, ty + pad + lh * (i + 1));
      });
    }
  }, [mapInfo, nodes, edges, highlightNodeId, hover]);

  // renderRef 항상 최신 유지
  useEffect(() => { renderRef.current = render; }, [render]);
  // 데이터/상태 변경 시 재렌더
  useEffect(() => { render(); }, [render]);

  // ResizeObserver
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      renderRef.current();
    });
    ro.observe(canvas);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => ro.disconnect();
  }, []);

  // ── 마우스 이벤트 ─────────────────────────────────────────────────────────

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const v = viewRef.current;
    if (!v) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    for (const n of nodes) {
      const [nx, ny] = worldToCanvas(n.x, n.y, v);
      if (Math.hypot(cx - nx, cy - ny) <= 10) {
        if (hover?.node_id !== n.node_id) setHover(n);
        return;
      }
    }
    if (hover) setHover(null);
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  return (
    <div className={`relative ${className} bg-[#080808] border border-[#1a1a1a] overflow-hidden`}>
      {!mapInfo && mapId && (
        <div className="absolute inset-0 flex items-center justify-center text-[#2a2a2a] text-xs font-mono select-none">
          맵 로딩 중…
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />

      {/* hover 좌표 — 우상단 */}
      {hover && (
        <div className="absolute top-1.5 right-2 text-[9px] font-mono text-[#888] bg-black/60 px-1.5 py-0.5 pointer-events-none">
          <span style={{ color: NODE_COLOR[hover.type] }}>{hover.node_id}</span>
          {"  "}x={hover.x.toFixed(3)}  y={hover.y.toFixed(3)}  yaw={hover.yaw.toFixed(3)}
        </div>
      )}

      {/* 범례 — 우하단 */}
      <div className="absolute bottom-1.5 right-2 flex flex-col gap-0.5 pointer-events-none">
        {(["WAYPOINT","STATION","CHARGER"] as const).map(t => (
          <div key={t} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ background: NODE_COLOR[t] }} />
            <span className="text-[8px] font-mono text-[#444]">{t}</span>
          </div>
        ))}
      </div>

      {/* 노드/엣지 수 — 좌하단 */}
      <div className="absolute bottom-1.5 left-2 text-[8px] font-mono text-[#333] pointer-events-none">
        N:{nodes.length} / E:{edges.length}
      </div>
    </div>
  );
}
