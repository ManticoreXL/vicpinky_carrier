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

type Mode = "select" | "node" | "edge";

// ── 좌표 변환 헬퍼 ────────────────────────────────────────────────────────────
// 맵 이미지가 캔버스에 fit-to-contain 방식으로 표시될 때의 변환

interface ViewState {
  scale: number;
  offX: number;   // canvas px
  offY: number;
  info: MapInfo;
}

function worldToCanvas(wx: number, wy: number, v: ViewState): [number, number] {
  const mapPx = (wx - v.info.originX) / v.info.resolution;
  const mapPy = v.info.height - (wy - v.info.originY) / v.info.resolution;
  return [mapPx * v.scale + v.offX, mapPy * v.scale + v.offY];
}

function canvasToWorld(cx: number, cy: number, v: ViewState): [number, number] {
  const mapPx = (cx - v.offX) / v.scale;
  const mapPy = (cy - v.offY) / v.scale;
  const wx = v.info.originX + mapPx * v.info.resolution;
  const wy = v.info.originY + (v.info.height - mapPy) * v.info.resolution;
  return [wx, wy];
}

// ── 색상 ─────────────────────────────────────────────────────────────────────

const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION:  "#fbbf24",
  CHARGER:  "#4ade80",
};

// ── API 헬퍼 ─────────────────────────────────────────────────────────────────

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(`${r.status}`);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ── 스타일 상수 ───────────────────────────────────────────────────────────────

const INP = "bg-[#111] border border-[#333] rounded px-2 py-1 text-[11px] text-[#ddd] font-mono w-full focus:outline-none focus:border-[#555]";
const SEL = `${INP} cursor-pointer`;
const BTN = (c: string) => `px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded border transition-colors ${c}`;

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function TopologyEditor() {
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const imgRef            = useRef<HTMLImageElement | null>(null);
  const viewRef           = useRef<ViewState | null>(null);
  const renderCallbackRef = useRef<() => void>(() => {});

  const [mapList,     setMapList]     = useState<string[]>([]);
  const [selMap,      setSelMap]      = useState("");
  const [mapInfo,     setMapInfo]     = useState<MapInfo | null>(null);
  const [nodes,       setNodes]       = useState<FNode[]>([]);
  const [edges,       setEdges]       = useState<FEdge[]>([]);
  const [mode,        setMode]        = useState<Mode>("select");
  const [selNodeId,   setSelNodeId]   = useState<string | null>(null);
  const [selEdgeId,   setSelEdgeId]   = useState<string | null>(null);
  const [edgeStart,   setEdgeStart]   = useState<string | null>(null);
  const [hover,       setHover]       = useState<[number, number] | null>(null);
  const [hoverNode,   setHoverNode]   = useState<FNode | null>(null);
  const [err,         setErr]         = useState("");

  // 노드 추가 폼
  const [addNode, setAddNode] = useState<Partial<FNode> | null>(null);
  // 엣지 추가 폼
  const [addEdge, setAddEdge] = useState<Partial<FEdge> | null>(null);
  // 수정 폼 (선택된 항목)
  const [editNode, setEditNode] = useState<Partial<FNode> | null>(null);
  const [editEdge, setEditEdge] = useState<Partial<FEdge> | null>(null);

  // ── 데이터 로드 ────────────────────────────────────────────────────────────

  useEffect(() => {
    api<string[]>("/api/map/static/list").then(setMapList).catch(() => {});
  }, []);

  const loadTopology = useCallback(async (mapId: string) => {
    if (!mapId) { setNodes([]); setEdges([]); return; }
    const [ns, es] = await Promise.all([
      api<FNode[]>(`/api/fleet/topology/nodes?map_id=${mapId}`),
      api<FEdge[]>(`/api/fleet/topology/edges?map_id=${mapId}`),
    ]);
    setNodes(ns);
    setEdges(es);
  }, []);

  useEffect(() => {
    if (!selMap) { setMapInfo(null); imgRef.current = null; setNodes([]); setEdges([]); return; }

    // 맵 메타 + 이미지 로드
    api<MapInfo>(`/api/map/static/${selMap}/info`)
      .then(info => {
        setMapInfo(info);
        const img = new Image();
        img.src = `${BACKEND_URL}/api/map/static/${selMap}/image`;
        img.onload = () => { imgRef.current = img; renderCallbackRef.current(); };
      })
      .catch(() => setErr("맵 정보 로드 실패"));

    void loadTopology(selMap);
  }, [selMap, loadTopology]);

  // ── 캔버스 렌더 ────────────────────────────────────────────────────────────

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !mapInfo) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 배경
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);

    // fit-to-contain 스케일 계산
    const scale = Math.min(W / mapInfo.width, H / mapInfo.height) * 0.95;
    const offX  = (W - mapInfo.width  * scale) / 2;
    const offY  = (H - mapInfo.height * scale) / 2;
    const view: ViewState = { scale, offX, offY, info: mapInfo };
    viewRef.current = view;

    // 맵 이미지
    if (img) {
      ctx.drawImage(img, offX, offY, mapInfo.width * scale, mapInfo.height * scale);
    } else {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(offX, offY, mapInfo.width * scale, mapInfo.height * scale);
    }

    // 엣지 렌더
    edges.forEach(e => {
      const sn = nodes.find(n => n.node_id === e.startNode);
      const en = nodes.find(n => n.node_id === e.endNode);
      if (!sn || !en) return;
      const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
      const [ex, ey] = worldToCanvas(en.x, en.y, view);

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      const isSel = e.edge_id === selEdgeId;
      ctx.strokeStyle = e.isLocked ? "#6b2424" : isSel ? "#f59e0b" : "#4b5563";
      ctx.lineWidth   = isSel ? 2.5 : 1.5;
      ctx.stroke();

      // ONE_WAY 화살표
      if (e.direction === "ONE_WAY") {
        const angle = Math.atan2(ey - sy, ex - sx);
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        const alen = 8;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx - alen * Math.cos(angle - 0.4), my - alen * Math.sin(angle - 0.4));
        ctx.lineTo(mx - alen * Math.cos(angle + 0.4), my - alen * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    });

    // 엣지 그리기 진행 중 선
    if (edgeStart && hover) {
      const sn = nodes.find(n => n.node_id === edgeStart);
      if (sn) {
        const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
        const [hx, hy] = worldToCanvas(hover[0], hover[1], view);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(hx, hy);
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 노드 렌더
    nodes.forEach(n => {
      const [cx, cy] = worldToCanvas(n.x, n.y, view);
      const r = n.node_id === selNodeId ? 9 : 7;
      const isEdgeStartNode = n.node_id === edgeStart;

      // 원
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = NODE_COLOR[n.type] ?? "#888";
      ctx.fill();
      if (n.node_id === selNodeId || isEdgeStartNode) {
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

    // 마우스 위치 십자선
    if (hover) {
      const [hx, hy] = worldToCanvas(hover[0], hover[1], view);
      ctx.strokeStyle = "#ffffff22";
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();

      // 노드 위 호버 시 x/y/yaw 플로팅 툴팁
      if (hoverNode) {
        const lines = [
          `x   ${hoverNode.x.toFixed(3)}`,
          `y   ${hoverNode.y.toFixed(3)}`,
          `yaw ${hoverNode.yaw.toFixed(3)} rad`,
        ];
        const pad = 7;
        const lh  = 14;
        const bw  = 148;
        const bh  = pad * 2 + lh * (lines.length + 1);
        let tx = hx + 16;
        let ty = hy - bh / 2;
        if (tx + bw > W) tx = hx - bw - 16;
        if (ty < 2)      ty = 2;
        if (ty + bh > H - 2) ty = H - bh - 2;

        ctx.fillStyle   = "rgba(8,8,8,0.88)";
        ctx.fillRect(tx, ty, bw, bh);
        ctx.strokeStyle = "#2a2a2a";
        ctx.lineWidth   = 1;
        ctx.strokeRect(tx, ty, bw, bh);

        // 노드 ID (헤더)
        ctx.font         = "bold 10px monospace";
        ctx.textAlign    = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle    = NODE_COLOR[hoverNode.type] ?? "#888";
        ctx.fillText(hoverNode.node_id, tx + pad, ty + pad);

        // 좌표값
        ctx.font      = "10px monospace";
        ctx.fillStyle = "#aaaaaa";
        lines.forEach((line, i) => {
          ctx.fillText(line, tx + pad, ty + pad + lh * (i + 1));
        });
      }
    }
  }, [mapInfo, nodes, edges, selNodeId, selEdgeId, edgeStart, hover, hoverNode]);

  // renderCallbackRef를 항상 최신 renderCanvas로 유지 (img.onload 스테일 클로저 방지)
  useEffect(() => { renderCallbackRef.current = renderCanvas; }, [renderCanvas]);

  // 맵 정보나 데이터 변경 시 재렌더
  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // 캔버스 크기 변경 감지
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      renderCanvas();
    });
    ro.observe(canvas);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => ro.disconnect();
  }, [renderCanvas]);

  // ── 마우스 이벤트 ─────────────────────────────────────────────────────────

  function hitNode(cx: number, cy: number): FNode | null {
    const v = viewRef.current;
    if (!v) return null;
    for (const n of nodes) {
      const [nx, ny] = worldToCanvas(n.x, n.y, v);
      if (Math.hypot(cx - nx, cy - ny) <= 10) return n;
    }
    return null;
  }

  function hitEdge(cx: number, cy: number): FEdge | null {
    const v = viewRef.current;
    if (!v) return null;
    for (const e of edges) {
      const sn = nodes.find(n => n.node_id === e.startNode);
      const en = nodes.find(n => n.node_id === e.endNode);
      if (!sn || !en) continue;
      const [sx, sy] = worldToCanvas(sn.x, sn.y, v);
      const [ex, ey] = worldToCanvas(en.x, en.y, v);
      const len = Math.hypot(ex - sx, ey - sy);
      if (len < 1) continue;
      const t = Math.max(0, Math.min(1, ((cx - sx) * (ex - sx) + (cy - sy) * (ey - sy)) / (len * len)));
      const dist = Math.hypot(cx - (sx + t * (ex - sx)), cy - (sy + t * (ey - sy)));
      if (dist <= 6) return e;
    }
    return null;
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const v = viewRef.current;
    if (!v) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [wx, wy] = canvasToWorld(cx, cy, v);
    setHover([wx, wy]);
    const n = hitNode(cx, cy);
    setHoverNode(n);
  }

  function handleMouseLeave() { setHover(null); setHoverNode(null); }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const v = viewRef.current;
    if (!v || !selMap) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx   = e.clientX - rect.left;
    const cy   = e.clientY - rect.top;
    const [wx, wy] = canvasToWorld(cx, cy, v);

    if (mode === "select") {
      const n = hitNode(cx, cy);
      if (n) {
        setSelNodeId(n.node_id); setSelEdgeId(null);
        setEditNode({ ...n }); setEditEdge(null);
      } else {
        const eg = hitEdge(cx, cy);
        if (eg) {
          setSelEdgeId(eg.edge_id); setSelNodeId(null);
          setEditEdge({ ...eg }); setEditNode(null);
        } else {
          setSelNodeId(null); setSelEdgeId(null);
          setEditNode(null); setEditEdge(null);
        }
      }
    } else if (mode === "node") {
      // 빈 곳 클릭 → 노드 추가 폼 열기 (좌표 미리 채움)
      const existing = hitNode(cx, cy);
      if (!existing) {
        setAddNode({ map_id: selMap, type: "WAYPOINT", x: +wx.toFixed(3), y: +wy.toFixed(3), yaw: 0 });
      }
    } else if (mode === "edge") {
      const n = hitNode(cx, cy);
      if (!n) return;
      if (!edgeStart) {
        setEdgeStart(n.node_id);
      } else if (edgeStart === n.node_id) {
        setEdgeStart(null);
      } else {
        // 두 번째 노드 클릭 → 엣지 추가 폼
        setAddEdge({
          map_id: selMap,
          startNode: edgeStart,
          endNode: n.node_id,
          direction: "BOTH_WAY",
          isLocked: false,
        });
        setEdgeStart(null);
      }
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async function saveNode() {
    if (!addNode?.node_id || addNode.x == null || addNode.y == null) { setErr("node_id 필수"); return; }
    try {
      await api("/api/fleet/topology/nodes", { method: "POST", body: JSON.stringify(addNode) });
      setAddNode(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function updateNode() {
    if (!selNodeId || !editNode) return;
    try {
      await api(`/api/fleet/topology/nodes/${selNodeId}`, { method: "PATCH", body: JSON.stringify(editNode) });
      setEditNode(null); setSelNodeId(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function deleteNode() {
    if (!selNodeId) return;
    try {
      await api(`/api/fleet/topology/nodes/${selNodeId}`, { method: "DELETE" });
      setSelNodeId(null); setEditNode(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function saveEdge() {
    if (!addEdge?.edge_id || !addEdge.startNode || !addEdge.endNode) { setErr("edge_id 필수"); return; }
    try {
      await api("/api/fleet/topology/edges", { method: "POST", body: JSON.stringify(addEdge) });
      setAddEdge(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function updateEdge() {
    if (!selEdgeId || !editEdge) return;
    try {
      await api(`/api/fleet/topology/edges/${selEdgeId}`, { method: "PATCH", body: JSON.stringify(editEdge) });
      setEditEdge(null); setSelEdgeId(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function deleteEdge() {
    if (!selEdgeId) return;
    try {
      await api(`/api/fleet/topology/edges/${selEdgeId}`, { method: "DELETE" });
      setSelEdgeId(null); setEditEdge(null); void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  async function toggleLock() {
    if (!selEdgeId || !editEdge) return;
    const newLocked = !editEdge.isLocked;
    try {
      await api(`/api/fleet/topology/edges/${selEdgeId}/lock`, {
        method: "PATCH", body: JSON.stringify({ isLocked: newLocked }),
      });
      setEditEdge(d => d && ({ ...d, isLocked: newLocked }));
      void loadTopology(selMap);
    } catch (ex) { setErr(String(ex)); }
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  const selNode = nodes.find(n => n.node_id === selNodeId);
  const selEdge = edges.find(e => e.edge_id === selEdgeId);

  return (
    <div className="h-full flex gap-0 overflow-hidden">

      {/* ── 캔버스 영역 ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* 툴바 */}
        <div className="flex-none flex items-center gap-2 px-3 py-2 bg-[#0a0a0a] border-b border-[#1a1a1a]">
          {/* 맵 선택 */}
          <select
            className={`${SEL} w-40`}
            value={selMap}
            onChange={e => { setSelMap(e.target.value); setSelNodeId(null); setSelEdgeId(null); setAddNode(null); setAddEdge(null); setEdgeStart(null); }}
          >
            <option value="">맵 선택…</option>
            {mapList.map(m => <option key={m} value={m}>{m}</option>)}
          </select>

          <div className="w-px h-5 bg-[#222]" />

          {/* 모드 버튼 */}
          {([
            ["select", "◈ 선택",  "text-[#888] border-[#333] hover:text-white"],
            ["node",   "⊕ 노드",  "text-blue-400 border-blue-900/60 hover:bg-blue-950/40"],
            ["edge",   "⇌ 엣지", "text-purple-400 border-purple-900/60 hover:bg-purple-950/40"],
          ] as [Mode, string, string][]).map(([m, label, color]) => (
            <button
              key={m}
              onClick={() => { setMode(m); setEdgeStart(null); setAddNode(null); setAddEdge(null); }}
              className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded border transition-colors ${
                mode === m ? color + " bg-opacity-50 brightness-150" : "border-[#222] text-[#444] hover:text-[#aaa]"
              } ${mode === m ? "ring-1 ring-inset ring-white/10" : ""}`}
            >{label}</button>
          ))}

          {/* 힌트 */}
          <span className="text-[10px] text-[#444] ml-2 font-mono">
            {mode === "select" ? "클릭으로 노드/엣지 선택" :
             mode === "node"   ? "빈 공간 클릭 → 노드 추가" :
             edgeStart         ? `'${edgeStart}' → 도착 노드 클릭` :
                                 "출발 노드 클릭"}
          </span>

          <div className="flex-1" />

          {/* 좌표 표시 */}
          {hover && mapInfo && (
            <span className="text-[10px] font-mono">
              {hoverNode ? (
                <span className="text-[#888]">
                  <span style={{ color: NODE_COLOR[hoverNode.type] }}>{hoverNode.node_id}</span>
                  {"  "}x={hoverNode.x.toFixed(3)}  y={hoverNode.y.toFixed(3)}  yaw={hoverNode.yaw.toFixed(3)}
                </span>
              ) : (
                <span className="text-[#555]">
                  x={hover[0].toFixed(3)}  y={hover[1].toFixed(3)}
                </span>
              )}
            </span>
          )}

          {/* 통계 */}
          <span className="text-[10px] text-[#444] font-mono">
            N:{nodes.length} / E:{edges.length}
          </span>
        </div>

        {/* 캔버스 */}
        <div className="flex-1 relative overflow-hidden bg-[#050505]">
          {!selMap && (
            <div className="absolute inset-0 flex items-center justify-center text-[#2a2a2a] text-sm font-mono select-none">
              위 드롭다운에서 맵을 선택하세요
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="w-full h-full block"
            style={{ cursor: mode === "select" ? "default" : "crosshair" }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
          />
        </div>
      </div>

      {/* ── 사이드 패널 ─────────────────────────────────────────────────── */}
      <div className="w-64 flex-none flex flex-col bg-[#080808] border-l border-[#1a1a1a] overflow-y-auto">

        {/* 범례 */}
        <div className="px-3 py-2 border-b border-[#141414]">
          <div className="text-[9px] text-[#444] uppercase tracking-widest mb-1.5">범례</div>
          <div className="flex flex-col gap-1">
            {[["WAYPOINT","#60a5fa"],["STATION","#fbbf24"],["CHARGER","#4ade80"]].map(([t,c]) => (
              <div key={t} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: c }} />
                <span className="text-[10px] text-[#666]">{t}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 mt-0.5">
              <div className="w-6 h-px bg-[#4b5563]" />
              <span className="text-[10px] text-[#666]">엣지 (열림)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-px bg-[#6b2424]" />
              <span className="text-[10px] text-[#666]">엣지 (잠김)</span>
            </div>
          </div>
        </div>

        {/* 에러 */}
        {err && (
          <div className="mx-2 mt-2 px-2 py-1.5 bg-red-950/40 border border-red-900/50 rounded text-[10px] text-red-400 font-mono flex justify-between">
            {err}
            <button className="text-[#555] hover:text-[#aaa] ml-2" onClick={() => setErr("")}>✕</button>
          </div>
        )}

        {/* ── 노드 추가 폼 ────────────────────────────────────────────── */}
        {addNode && (
          <PanelSection title="노드 추가">
            <Field label="node_id">
              <input className={INP} value={addNode.node_id ?? ""} onChange={e => setAddNode(d => ({ ...d, node_id: e.target.value }))} />
            </Field>
            <Field label="타입">
              <select className={SEL} value={addNode.type} onChange={e => setAddNode(d => ({ ...d, type: e.target.value as FNode["type"] }))}>
                <option value="WAYPOINT">WAYPOINT</option>
                <option value="STATION">STATION</option>
                <option value="CHARGER">CHARGER</option>
              </select>
            </Field>
            <Field label="x (m)">
              <input className={INP} type="number" step="0.001" value={addNode.x ?? 0} onChange={e => setAddNode(d => ({ ...d, x: +e.target.value }))} />
            </Field>
            <Field label="y (m)">
              <input className={INP} type="number" step="0.001" value={addNode.y ?? 0} onChange={e => setAddNode(d => ({ ...d, y: +e.target.value }))} />
            </Field>
            <Field label="yaw (rad)">
              <input className={INP} type="number" step="0.01" value={addNode.yaw ?? 0} onChange={e => setAddNode(d => ({ ...d, yaw: +e.target.value }))} />
            </Field>
            <div className="flex gap-1 mt-2">
              <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60 hover:bg-green-800/50 flex-1")} onClick={saveNode}>저장</button>
              <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa] flex-1")} onClick={() => setAddNode(null)}>취소</button>
            </div>
          </PanelSection>
        )}

        {/* ── 엣지 추가 폼 ────────────────────────────────────────────── */}
        {addEdge && (
          <PanelSection title="엣지 추가">
            <Field label="edge_id">
              <input className={INP} value={addEdge.edge_id ?? ""} onChange={e => setAddEdge(d => ({ ...d, edge_id: e.target.value }))} />
            </Field>
            <Field label="출발 노드">
              <input className={`${INP} text-[#aaa]`} readOnly value={addEdge.startNode ?? ""} />
            </Field>
            <Field label="도착 노드">
              <input className={`${INP} text-[#aaa]`} readOnly value={addEdge.endNode ?? ""} />
            </Field>
            <Field label="방향">
              <select className={SEL} value={addEdge.direction} onChange={e => setAddEdge(d => ({ ...d, direction: e.target.value as FEdge["direction"] }))}>
                <option value="BOTH_WAY">BOTH_WAY</option>
                <option value="ONE_WAY">ONE_WAY</option>
              </select>
            </Field>
            <div className="flex gap-1 mt-2">
              <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60 hover:bg-green-800/50 flex-1")} onClick={saveEdge}>저장</button>
              <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa] flex-1")} onClick={() => setAddEdge(null)}>취소</button>
            </div>
          </PanelSection>
        )}

        {/* ── 선택된 노드 편집 ─────────────────────────────────────────── */}
        {selNode && editNode && !addNode && !addEdge && (
          <PanelSection title={`노드: ${selNode.node_id}`}>
            <Field label="타입">
              <select className={SEL} value={editNode.type ?? selNode.type} onChange={e => setEditNode(d => ({ ...d, type: e.target.value as FNode["type"] }))}>
                <option value="WAYPOINT">WAYPOINT</option>
                <option value="STATION">STATION</option>
                <option value="CHARGER">CHARGER</option>
              </select>
            </Field>
            <Field label="x (m)">
              <input className={INP} type="number" step="0.001" value={editNode.x ?? selNode.x} onChange={e => setEditNode(d => ({ ...d, x: +e.target.value }))} />
            </Field>
            <Field label="y (m)">
              <input className={INP} type="number" step="0.001" value={editNode.y ?? selNode.y} onChange={e => setEditNode(d => ({ ...d, y: +e.target.value }))} />
            </Field>
            <Field label="yaw (rad)">
              <input className={INP} type="number" step="0.01" value={editNode.yaw ?? selNode.yaw} onChange={e => setEditNode(d => ({ ...d, yaw: +e.target.value }))} />
            </Field>
            <div className="flex gap-1 mt-2">
              <button className={BTN("bg-blue-900/40 text-blue-300 border-blue-800/60 hover:bg-blue-800/50 flex-1")} onClick={updateNode}>수정</button>
              <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60 hover:bg-red-800/50 flex-1")} onClick={deleteNode}>삭제</button>
            </div>
            <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa] w-full mt-1")} onClick={() => { setSelNodeId(null); setEditNode(null); }}>선택 해제</button>
          </PanelSection>
        )}

        {/* ── 선택된 엣지 편집 ─────────────────────────────────────────── */}
        {selEdge && editEdge && !addNode && !addEdge && (
          <PanelSection title={`엣지: ${selEdge.edge_id}`}>
            <div className="text-[10px] text-[#666] font-mono mb-2">
              {selEdge.startNode} → {selEdge.endNode}
            </div>
            <Field label="방향">
              <select className={SEL} value={editEdge.direction ?? selEdge.direction} onChange={e => setEditEdge(d => ({ ...d, direction: e.target.value as FEdge["direction"] }))}>
                <option value="BOTH_WAY">BOTH_WAY</option>
                <option value="ONE_WAY">ONE_WAY</option>
              </select>
            </Field>
            <Field label="잠금">
              <button
                onClick={toggleLock}
                className={`px-2 py-1 text-[10px] font-bold rounded border w-full ${
                  editEdge.isLocked ?? selEdge.isLocked
                    ? "bg-red-900/40 text-red-300 border-red-800/60"
                    : "bg-[#111] text-[#555] border-[#333] hover:text-green-400"
                }`}
              >{(editEdge.isLocked ?? selEdge.isLocked) ? "잠김 — 클릭으로 해제" : "열림 — 클릭으로 잠금"}</button>
            </Field>
            <div className="flex gap-1 mt-2">
              <button className={BTN("bg-blue-900/40 text-blue-300 border-blue-800/60 hover:bg-blue-800/50 flex-1")} onClick={updateEdge}>수정</button>
              <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60 hover:bg-red-800/50 flex-1")} onClick={deleteEdge}>삭제</button>
            </div>
            <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa] w-full mt-1")} onClick={() => { setSelEdgeId(null); setEditEdge(null); }}>선택 해제</button>
          </PanelSection>
        )}

        {/* 기본 안내 */}
        {!addNode && !addEdge && !selNode && !selEdge && selMap && (
          <div className="px-3 py-4 text-[10px] text-[#333] font-mono leading-relaxed">
            {mode === "select" && "노드나 엣지를 클릭해 선택하세요."}
            {mode === "node"   && "맵 빈 공간을 클릭해 노드를 추가하세요."}
            {mode === "edge"   && "출발 노드를 클릭한 뒤 도착 노드를 클릭하세요."}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 공통 소형 컴포넌트 ────────────────────────────────────────────────────────

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#141414] px-3 py-3">
      <div className="text-[10px] text-[#555] uppercase tracking-widest mb-2">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="text-[9px] text-[#444] mb-0.5 uppercase tracking-wider">{label}</div>
      {children}
    </div>
  );
}
