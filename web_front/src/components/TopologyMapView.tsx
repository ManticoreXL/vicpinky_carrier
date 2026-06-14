import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BACKEND_URL } from "../config";

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface MapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

export interface FNode {
  node_id: string;
  map_id: string;
  type: "WAYPOINT" | "STATION" | "CHARGER";
  x: number;
  y: number;
  yaw: number;
}

export interface FEdge {
  edge_id: string;
  map_id: string;
  startNode: string;
  endNode: string;
  direction: "ONE_WAY" | "BOTH_WAY";
  isLocked: boolean;
}

export interface ActivePath {
  robotId: string;
  pathQueue: string[];    // 남은 노드들 (pathQueue[0] = 다음 목적지)
  fromNodeId?: string;    // 현재 출발 노드 (robot.location)
}

export interface RobotPos {
  x: number;
  y: number;
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

// ── 색상 ─────────────────────────────────────────────────────────────────────

const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION:  "#fbbf24",
  CHARGER:  "#4ade80",
};

// 로봇별 색상 (최대 6대)
const ROBOT_COLORS = [
  "#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#38bdf8",
];

// ── 노드 좌표에서 가상 mapInfo 도출 ──────────────────────────────────────────

function deriveMapInfo(nodes: FNode[]): MapInfo {
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - 3;
  const maxX = Math.max(...xs) + 3;
  const minY = Math.min(...ys) - 3;
  const maxY = Math.max(...ys) + 3;
  const res  = 0.05;
  return {
    resolution: res,
    width:  Math.ceil((maxX - minX) / res),
    height: Math.ceil((maxY - minY) / res),
    originX: minX,
    originY: minY,
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  mapId: string;
  className?: string;
  highlightNodeId?: string | null;
  activePaths?: ActivePath[];           // 진행 중인 로봇 경로
  robotPositions?: Record<string, RobotPos>;  // 로봇 위치 (world 좌표)
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function TopologyMapView({
  mapId, className = "h-72", highlightNodeId, activePaths = [], robotPositions = {},
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const viewRef   = useRef<ViewState | null>(null);
  const renderRef = useRef<() => void>(() => {});

  const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
  const [nodes,   setNodes]   = useState<FNode[]>([]);
  const [edges,   setEdges]   = useState<FEdge[]>([]);
  const [hover,   setHover]   = useState<FNode | null>(null);

  // ── 활성 경로에서 강조할 노드/엣지 도출 ──────────────────────────────────

  // robotId → color
  const robotColorMap = useMemo(() => {
    const m: Record<string, string> = {};
    activePaths.forEach(({ robotId }, i) => {
      m[robotId] = ROBOT_COLORS[i % ROBOT_COLORS.length];
    });
    return m;
  }, [activePaths]);

  // activeNodeId → robotId (어떤 로봇이 지나갈 노드)
  const activeNodeMap = useMemo(() => {
    const m: Record<string, string> = {};
    activePaths.forEach(({ robotId, pathQueue, fromNodeId }) => {
      if (fromNodeId) m[fromNodeId] = robotId;
      pathQueue.forEach(id => { m[id] = robotId; });
    });
    return m;
  }, [activePaths]);

  // activeEdgeId → robotId (어떤 로봇이 지나가는 엣지)
  const activeEdgeMap = useMemo(() => {
    const m: Record<string, string> = {};
    activePaths.forEach(({ robotId, pathQueue, fromNodeId }) => {
      const fullPath = fromNodeId ? [fromNodeId, ...pathQueue] : pathQueue;
      for (let i = 0; i < fullPath.length - 1; i++) {
        const a = fullPath[i];
        const b = fullPath[i + 1];
        // edge_id가 아닌 start/end 조합으로 매칭
        const edgeKey = `${a}→${b}`;
        m[edgeKey] = robotId;
      }
    });
    return m;
  }, [activePaths]);

  // ── 데이터 로드 ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapId) {
      setMapInfo(null); imgRef.current = null; setNodes([]); setEdges([]);
      return;
    }

    // 정적 맵 이미지/메타데이터 시도 (없어도 노드는 보임)
    fetch(`${BACKEND_URL}/api/map/static/${mapId}/info`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((info: MapInfo) => {
        setMapInfo(info);
        const img = new Image();
        img.src = `${BACKEND_URL}/api/map/static/${mapId}/image`;
        img.onload  = () => { imgRef.current = img;   renderRef.current(); };
        img.onerror = () => { imgRef.current = null; };
      })
      .catch(() => { /* 정적 맵 없음 — 노드 좌표계로 대체 */ });

    Promise.all([
      fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${mapId}`)
        .then(r => r.json()).catch(() => []),
      fetch(`${BACKEND_URL}/api/fleet/topology/edges`)
        .then(r => r.json()).catch(() => []),
    ]).then(([ns, es]) => {
      const loadedNodes = Array.isArray(ns) ? ns as FNode[] : [];
      const nodeIds = new Set(loadedNodes.map(n => n.node_id));
      const allEdges = Array.isArray(es) ? es as FEdge[] : [];
      const filteredEdges = allEdges.filter(e => nodeIds.has(e.startNode) && nodeIds.has(e.endNode));
      setNodes(loadedNodes);
      setEdges(filteredEdges);
    });
  }, [mapId]);

  // ── 캔버스 렌더 ────────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas) return;

    // mapInfo가 없으면 노드 좌표에서 가상 맵 정보 도출
    const effectiveInfo: MapInfo | null =
      mapInfo ?? (nodes.length > 0 ? deriveMapInfo(nodes) : null);

    if (!effectiveInfo) return;   // 노드도 없으면 그릴 것이 없음

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    if (W === 0 || H === 0) return;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);

    const scale = Math.min(W / effectiveInfo.width, H / effectiveInfo.height) * 0.92;
    const offX  = (W - effectiveInfo.width  * scale) / 2;
    const offY  = (H - effectiveInfo.height * scale) / 2;
    const view: ViewState = { scale, offX, offY, info: effectiveInfo };
    viewRef.current = view;

    // 맵 이미지 (있을 때만)
    if (img && mapInfo) {
      ctx.drawImage(img, offX, offY, effectiveInfo.width * scale, effectiveInfo.height * scale);
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(offX, offY, effectiveInfo.width * scale, effectiveInfo.height * scale);
    }

    // ── 엣지 렌더 ─────────────────────────────────────────────────────────

    edges.forEach(e => {
      const sn = nodes.find(n => n.node_id === e.startNode);
      const en = nodes.find(n => n.node_id === e.endNode);
      if (!sn || !en) return;
      const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
      const [ex, ey] = worldToCanvas(en.x, en.y, view);

      // 어떤 로봇이 이 엣지를 지나는지 확인 (양방향 모두)
      const fwdKey = `${e.startNode}→${e.endNode}`;
      const bwdKey = `${e.endNode}→${e.startNode}`;
      const activeRobot = activeEdgeMap[fwdKey] ?? activeEdgeMap[bwdKey];
      const robotColor  = activeRobot ? robotColorMap[activeRobot] : null;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);

      if (robotColor) {
        ctx.strokeStyle = robotColor;
        ctx.lineWidth   = 3.5;
        ctx.globalAlpha = 0.85;
      } else if (e.isLocked) {
        ctx.strokeStyle = "#6b2424";
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = "#374151";
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ONE_WAY 화살표
      if (e.direction === "ONE_WAY") {
        const angle = Math.atan2(ey - sy, ex - sx);
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        const al = robotColor ? 10 : 8;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - al * Math.cos(angle - 0.4), my - al * Math.sin(angle - 0.4));
        ctx.lineTo(mx - al * Math.cos(angle + 0.4), my - al * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = robotColor ?? "#374151";
        ctx.globalAlpha = robotColor ? 0.85 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // 활성 엣지 — 로봇 ID 라벨
      if (robotColor && activeRobot) {
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        ctx.font      = "bold 9px monospace";
        ctx.fillStyle = robotColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(activeRobot, mx, my - 4);
      }
    });

    // ── 노드 렌더 ─────────────────────────────────────────────────────────

    nodes.forEach(n => {
      const [cx, cy] = worldToCanvas(n.x, n.y, view);
      const activeRobot = activeNodeMap[n.node_id];
      const robotColor  = activeRobot ? robotColorMap[activeRobot] : null;
      const isHl  = n.node_id === highlightNodeId;
      const isHov = n.node_id === hover?.node_id;
      const r = isHl ? 9 : robotColor ? 8 : isHov ? 8 : 6;

      // 활성 노드 — 외곽 후광
      if (robotColor) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = robotColor + "33";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = NODE_COLOR[n.type] ?? "#888";
      ctx.fill();

      if (isHl || isHov || robotColor) {
        ctx.strokeStyle = robotColor ?? "#fff";
        ctx.lineWidth   = robotColor ? 2.5 : 2;
        ctx.stroke();
      }

      // yaw 방향 화살표
      const yawX = cx + Math.cos(n.yaw) * (r + 5);
      const yawY = cy - Math.sin(n.yaw) * (r + 5);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(yawX, yawY);
      ctx.strokeStyle = "#ffffff66";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // 라벨
      ctx.fillStyle    = robotColor ? robotColor : "#ffffffcc";
      ctx.font         = robotColor ? "bold 10px monospace" : "10px monospace";
      ctx.textAlign    = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(n.node_id, cx + r + 2, cy);
    });

    // ── 로봇 실제 위치 점 ─────────────────────────────────────────────────

    Object.entries(robotPositions).forEach(([robotId, pos], i) => {
      const color = robotColorMap[robotId] ?? ROBOT_COLORS[i % ROBOT_COLORS.length];
      const [cx, cy] = worldToCanvas(pos.x, pos.y, view);

      // 위치 점
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // 로봇 ID
      ctx.font         = "bold 9px monospace";
      ctx.fillStyle    = color;
      ctx.textAlign    = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(robotId, cx, cy - 7);
    });

    // ── hover 노드 툴팁 ──────────────────────────────────────────────────

    if (hover) {
      const [hx, hy] = worldToCanvas(hover.x, hover.y, view);
      const lines = [
        `x   ${hover.x.toFixed(3)}`,
        `y   ${hover.y.toFixed(3)}`,
        `yaw ${hover.yaw.toFixed(3)} rad`,
      ];
      const activeR = activeNodeMap[hover.node_id];
      if (activeR) lines.push(`로봇 ${activeR}`);

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
      ctx.fillStyle    = activeNodeMap[hover.node_id]
        ? (robotColorMap[activeNodeMap[hover.node_id]] ?? NODE_COLOR[hover.type])
        : NODE_COLOR[hover.type] ?? "#888";
      ctx.fillText(hover.node_id, tx + pad, ty + pad);

      ctx.font      = "10px monospace";
      ctx.fillStyle = "#aaa";
      lines.forEach((line, i) => ctx.fillText(line, tx + pad, ty + pad + lh * (i + 1)));
    }
  }, [mapInfo, nodes, edges, highlightNodeId, hover, activeNodeMap, activeEdgeMap, robotColorMap, robotPositions]);

  // renderRef 항상 최신 유지
  useEffect(() => { renderRef.current = render; }, [render]);
  // 상태 변경 시 재렌더
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
      {!mapInfo && !nodes.length && mapId && (
        <div className="absolute inset-0 flex items-center justify-center text-[#2a2a2a] text-xs font-mono select-none">
          맵 로딩 중…
        </div>
      )}
      {!mapInfo && nodes.length > 0 && (
        <div className="absolute top-1.5 left-2 text-[8px] font-mono text-[#333] pointer-events-none">
          정적 맵 없음 — 노드 좌표계
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
          <span style={{ color: activeNodeMap[hover.node_id] ? robotColorMap[activeNodeMap[hover.node_id]] : NODE_COLOR[hover.type] }}>
            {hover.node_id}
          </span>
          {"  "}x={hover.x.toFixed(3)}  y={hover.y.toFixed(3)}  yaw={hover.yaw.toFixed(3)}
        </div>
      )}

      {/* 활성 로봇 범례 — 우하단 */}
      <div className="absolute bottom-1.5 right-2 flex flex-col gap-0.5 pointer-events-none">
        {activePaths.map(({ robotId }) => (
          <div key={robotId} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ background: robotColorMap[robotId] }} />
            <span className="text-[8px] font-mono" style={{ color: robotColorMap[robotId] }}>{robotId}</span>
          </div>
        ))}
        {(["WAYPOINT","STATION","CHARGER"] as const).map(t => (
          <div key={t} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ background: NODE_COLOR[t] }} />
            <span className="text-[8px] font-mono text-[#444]">{t}</span>
          </div>
        ))}
      </div>

      {/* N/E 통계 — 좌하단 */}
      <div className="absolute bottom-1.5 left-2 text-[8px] font-mono text-[#333] pointer-events-none">
        N:{nodes.length} / E:{edges.length}
        {activePaths.length > 0 && (
          <span className="ml-2 text-amber-500">{activePaths.length}대 활성</span>
        )}
      </div>
    </div>
  );
}
