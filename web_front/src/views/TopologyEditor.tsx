import { useState, useEffect, useRef, useCallback } from "react";
import { BACKEND_URL } from "../config";
import { snapNodes } from "../components/TopologyMapView";
import type { MapInfo, FNode, FEdge, Mode, ViewState } from "./editor/types";
import { worldToCanvas, canvasToWorld } from "./editor/geometry";
import { NODE_COLOR, INP, SEL, BTN } from "./editor/constants";
import { api } from "./editor/api";
import { renderScene } from "./editor/renderScene";
import { PanelSection, Field } from "./editor/common";

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function TopologyEditor() {
 const canvasRef = useRef<HTMLCanvasElement>(null);
 const imgRef = useRef<HTMLImageElement | null>(null);
 const viewRef = useRef<ViewState | null>(null);
 const renderCallbackRef = useRef<() => void>(() => {});

 // 드래그 상태 (ref — 렌더 트리거 불필요)
 const dragNodeIdRef = useRef<string | null>(null);
 const dragStartCanvasRef = useRef<[number, number] | null>(null);
 const hasDraggedRef = useRef(false);

 const [mapList, setMapList] = useState<string[]>([]);
 const [selMap, setSelMap] = useState("");
 const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
 const [nodes, setNodes] = useState<FNode[]>([]);
 const [edges, setEdges] = useState<FEdge[]>([]);
 const [mode, setMode] = useState<Mode>("select");
 const [selNodeId, setSelNodeId] = useState<string | null>(null);
 const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
 const [edgeStart, setEdgeStart] = useState<string | null>(null);
 const [hover, setHover] = useState<[number, number] | null>(null);
 const [hoverNode, setHoverNode] = useState<FNode | null>(null);
 const [err, setErr] = useState("");
 const [isDragging, setIsDragging] = useState(false);

 // 노드 추가 폼
 const [addNode, setAddNode] = useState<Partial<FNode> | null>(null);
 // 엣지 추가 폼
 const [addEdge, setAddEdge] = useState<Partial<FEdge> | null>(null);
 // 수정 폼
 const [editNode, setEditNode] = useState<FNode | null>(null);
 const [editEdge, setEditEdge] = useState<FEdge | null>(null);

 // ── 데이터 로드 ────────────────────────────────────────────────────────────

 useEffect(() => {
  api<string[]>("/api/map/static/list").then(setMapList).catch(() => {});
 }, []);

 const loadTopology = useCallback(async (mapId: string, threshold = 0.25) => {
  if (!mapId) { setNodes([]); setEdges([]); return; }
  const [ns, es] = await Promise.all([
   api<FNode[]>(`/api/fleet/topology/nodes?map_id=${mapId}`),
   api<FEdge[]>(`/api/fleet/topology/edges?map_id=${mapId}`),
  ]);
  const snappedNs = snapNodes(ns || [], threshold);
  setNodes(snappedNs);
  setEdges(es || []);
 }, []);

 useEffect(() => {
  if (!selMap) { setMapInfo(null); imgRef.current = null; setNodes([]); setEdges([]); return; }
  api<MapInfo>(`/api/map/static/${selMap}/info`)
   .then(info => {
    setMapInfo(info);
    const img = new Image();
    img.src = `${BACKEND_URL}/api/map/static/${selMap}/image`;
    img.onload = () => { imgRef.current = img; renderCallbackRef.current(); };
    void loadTopology(selMap, info.snapThreshold ?? 0.25);
   })
   .catch(() => {
    setErr("맵 정보 로드 실패");
    void loadTopology(selMap, 0.25);
   });
 }, [selMap, loadTopology]);

 // ── 캔버스 렌더 ────────────────────────────────────────────────────────────

 const renderCanvas = useCallback(() => {
  const canvas = canvasRef.current;
  if (!canvas || !mapInfo) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  viewRef.current = renderScene(ctx, canvas, imgRef.current, mapInfo, nodes, edges, {
   selNodeId, selEdgeId, edgeStart, hover, hoverNode,
   dragNodeId: dragNodeIdRef.current, hasDragged: hasDraggedRef.current,
  });
 }, [mapInfo, nodes, edges, selNodeId, selEdgeId, edgeStart, hover, hoverNode]);

 useEffect(() => { renderCallbackRef.current = renderCanvas; }, [renderCanvas]);
 useEffect(() => { renderCanvas(); }, [renderCanvas]);

 useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ro = new ResizeObserver(() => {
   canvas.width = canvas.offsetWidth;
   canvas.height = canvas.offsetHeight;
   renderCanvas();
  });
  ro.observe(canvas);
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  return () => ro.disconnect();
 }, [renderCanvas]);

 // ── 히트 테스트 ───────────────────────────────────────────────────────────

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

 // ── 마우스 이벤트 ─────────────────────────────────────────────────────────

 function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
  if (mode !== "select") return;
  const v = viewRef.current;
  if (!v) return;
  const rect = canvasRef.current!.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const n = hitNode(cx, cy);
  if (n) {
   dragNodeIdRef.current = n.node_id;
   dragStartCanvasRef.current = [cx, cy];
   hasDraggedRef.current = false;
  }
 }

 function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
  const v = viewRef.current;
  if (!v) return;
  const rect = canvasRef.current!.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const [wx, wy] = canvasToWorld(cx, cy, v);
  setHover([wx, wy]);

  if (dragNodeIdRef.current && dragStartCanvasRef.current) {
   const [sx, sy] = dragStartCanvasRef.current;
   if (!hasDraggedRef.current && Math.hypot(cx - sx, cy - sy) > 4) {
    hasDraggedRef.current = true;
    setIsDragging(true);
   }
   if (hasDraggedRef.current) {
    const nx = +wx.toFixed(3);
    const ny = +wy.toFixed(3);
    setNodes(prev => prev.map(n =>
     n.node_id === dragNodeIdRef.current ? { ...n, x: nx, y: ny } : n
    ));
    setEditNode(d => d && d.node_id === dragNodeIdRef.current ? { ...d, x: nx, y: ny } : d);
   }
  }

  const hn = hitNode(cx, cy);
  setHoverNode(hn);
 }

 async function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
  const v = viewRef.current;
  if (!v) return;

  if (dragNodeIdRef.current && hasDraggedRef.current) {
   const nodeId = dragNodeIdRef.current;
   const node = nodes.find(n => n.node_id === nodeId);
   if (node) {
    try {
     await api(`/api/fleet/topology/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ x: node.x, y: node.y }),
     });
    } catch (ex) { setErr(String(ex)); }
   }
  }

  setIsDragging(false);
  dragNodeIdRef.current = null;
  dragStartCanvasRef.current = null;
 }

 function handleMouseLeave() {
  setHover(null);
  setHoverNode(null);
  if (hasDraggedRef.current) {
   // 마우스가 캔버스 밖으로 나가면 드래그 취소 후 리로드
   hasDraggedRef.current = false;
   setIsDragging(false);
   dragNodeIdRef.current = null;
   void loadTopology(selMap);
  }
 }

 function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
  // 드래그 후 click 이벤트 무시
  if (hasDraggedRef.current) {
   hasDraggedRef.current = false;
   return;
  }
  hasDraggedRef.current = false;

  const v = viewRef.current;
  if (!v || !selMap) return;
  const rect = canvasRef.current!.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
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
   const { node_id: newId, ...rest } = editNode;
   if (newId && newId !== selNodeId) {
    await api(`/api/fleet/topology/nodes/${selNodeId}/rename`, {
     method: "PATCH", body: JSON.stringify({ new_id: newId }),
    });
    await api(`/api/fleet/topology/nodes/${newId}`, {
     method: "PATCH", body: JSON.stringify(rest),
    });
   } else {
    await api(`/api/fleet/topology/nodes/${selNodeId}`, {
     method: "PATCH", body: JSON.stringify(rest),
    });
   }
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
   const { edge_id: newId, ...rest } = editEdge;
   if (newId && newId !== selEdgeId) {
    await api(`/api/fleet/topology/edges/${selEdgeId}/rename`, {
     method: "PATCH", body: JSON.stringify({ new_id: newId }),
    });
    await api(`/api/fleet/topology/edges/${newId}`, {
     method: "PATCH", body: JSON.stringify(rest),
    });
   } else {
    await api(`/api/fleet/topology/edges/${selEdgeId}`, {
     method: "PATCH", body: JSON.stringify(rest),
    });
   }
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

 const canvasCursor =
  isDragging ? "grabbing" :
  mode === "select" ? (hoverNode ? "grab" : "default") :
  "crosshair";

 return (
  <div className="h-full flex gap-0 overflow-hidden">

   {/* ── 캔버스 영역 ─────────────────────────────────────────────────── */}
   <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

    {/* 툴바 */}
    <div className="flex-none flex items-center gap-2 px-3 py-2 bg-[#FFCE99]/32 border-b border-white/[0.1]">
     <select
      className={`${SEL} w-40`}
      value={selMap}
      onChange={e => { setSelMap(e.target.value); setSelNodeId(null); setSelEdgeId(null); setAddNode(null); setAddEdge(null); setEdgeStart(null); }}
     >
      <option value="">맵 선택…</option>
      {mapList.map(m => <option key={m} value={m}>{m}</option>)}
     </select>

     <div className="w-px h-5 bg-white/10" />

     {([
      ["select", "◈ 선택", "text-white/[0.75] border-white/[0.1] hover:text-white"],
      ["node",   "⊕ 노드", "text-white/90 border-white/[0.1] hover:bg-blue-950/40"],
      ["edge",   "⇌ 엣지", "text-white/90 border-white/[0.1] hover:bg-purple-950/40"],
     ] as [Mode, string, string][]).map(([m, label, color]) => (
      <button
       key={m}
       onClick={() => { setMode(m); setEdgeStart(null); setAddNode(null); setAddEdge(null); }}
       className={`px-3 py-1 text-xs font-bold tracking-wider rounded border transition-colors ${
        mode === m ? color + " bg-opacity-50 brightness-150" : "border-white/[0.1] text-white/[0.6] hover:text-white/90"
       } ${mode === m ? "ring-1 ring-inset ring-white/10" : ""}`}
      >{label}</button>
     ))}

     <span className="text-xs text-white/[0.6] ml-2">
      {mode === "select"
       ? (isDragging ? "드래그로 노드 이동 중…" : "클릭으로 선택 / 드래그로 이동")
       : mode === "node" ? "빈 공간 클릭 → 노드 추가"
       : edgeStart ? `'${edgeStart}' → 도착 노드 클릭`
       : "출발 노드 클릭"}
     </span>

     <div className="flex-1" />

     {hover && mapInfo && (
      <span className="text-xs">
       {hoverNode ? (
        <span className="text-white/[0.75]">
         <span style={{ color: NODE_COLOR[hoverNode.type] }}>{hoverNode.node_id}</span>
         {" "}x={hoverNode.x.toFixed(3)} y={hoverNode.y.toFixed(3)} yaw={hoverNode.yaw.toFixed(3)}
        </span>
       ) : (
        <span className="text-white/[0.68]">
         x={hover[0].toFixed(3)} y={hover[1].toFixed(3)}
        </span>
       )}
      </span>
     )}

     <span className="text-xs text-white/[0.6]">
      N:{nodes.length} / E:{edges.length}
     </span>
    </div>

    {/* 캔버스 */}
    <div className="flex-1 relative overflow-hidden bg-[#FFCE99]/14 backdrop-blur-xl">
     {!selMap && (
      <div className="absolute inset-0 flex items-center justify-center text-white/[0.55] text-sm select-none">
       위 드롭다운에서 맵을 선택하세요
      </div>
     )}
     <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ cursor: canvasCursor }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
     />
    </div>
   </div>

   {/* ── 사이드 패널 ─────────────────────────────────────────────────── */}
   <div className="w-64 flex-none flex flex-col bg-[#FFCE99]/32 border-l border-white/[0.1] overflow-y-auto">

    {/* 범례 */}
    <div className="px-3 py-2 border-b border-white/[0.1]">
     <div className="text-xs text-white/[0.6] tracking-wide mb-1.5">범례</div>
     <div className="flex flex-col gap-1">
      {[["WAYPOINT","#60a5fa"],["STATION","#fbbf24"],["CHARGER","#4ade80"]].map(([t,c]) => (
       <div key={t} className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ background: c }} />
        <span className="text-xs text-white/[0.75]">{t}</span>
       </div>
      ))}
      <div className="flex items-center gap-2 mt-0.5">
       <div className="w-6 h-px bg-[#521C0D]/30" />
       <span className="text-xs text-white/[0.75]">엣지 (열림)</span>
      </div>
      <div className="flex items-center gap-2">
       <div className="w-6 h-px bg-[#D5451B]/60" />
       <span className="text-xs text-white/[0.75]">엣지 (잠김)</span>
      </div>
     </div>
    </div>

    {/* 에러 */}
    {err && (
     <div className="mx-2 mt-2 px-2 py-1.5 bg-red-950/40 border border-white/[0.1] rounded text-xs text-white/90 flex justify-between">
      {err}
      <button className="text-white/[0.68] hover:text-white/90 ml-2" onClick={() => setErr("")}>✕</button>
     </div>
    )}

    {/* ── 노드 추가 폼 ────────────────────────────────────────────── */}
    {addNode && (
     <PanelSection title="노드 추가">
      <Field label="node_id">
       <input className={INP} value={addNode.node_id ?? ""} onChange={e => setAddNode(d => ({ ...d, node_id: e.target.value }))} autoFocus />
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
       <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1] hover:bg-green-800/50 flex-1")} onClick={saveNode}>저장</button>
       <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90 flex-1")} onClick={() => setAddNode(null)}>취소</button>
      </div>
     </PanelSection>
    )}

    {/* ── 엣지 추가 폼 ────────────────────────────────────────────── */}
    {addEdge && (
     <PanelSection title="엣지 추가">
      <Field label="edge_id">
       <input className={INP} value={addEdge.edge_id ?? ""} onChange={e => setAddEdge(d => ({ ...d, edge_id: e.target.value }))} autoFocus />
      </Field>
      <Field label="출발 노드">
       <input className={`${INP} text-white/[0.68]`} readOnly value={addEdge.startNode ?? ""} />
      </Field>
      <Field label="도착 노드">
       <input className={`${INP} text-white/[0.68]`} readOnly value={addEdge.endNode ?? ""} />
      </Field>
      <Field label="방향">
       <select className={SEL} value={addEdge.direction} onChange={e => setAddEdge(d => ({ ...d, direction: e.target.value as FEdge["direction"] }))}>
        <option value="BOTH_WAY">BOTH_WAY</option>
        <option value="ONE_WAY">ONE_WAY</option>
       </select>
      </Field>
      <Field label="가중치">
       <input className={INP} type="number" step="1" value={addEdge.weight ?? 1} onChange={e => setAddEdge(d => ({ ...d, weight: +e.target.value }))} />
      </Field>
      <div className="flex gap-1 mt-2">
       <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1] hover:bg-green-800/50 flex-1")} onClick={saveEdge}>저장</button>
       <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90 flex-1")} onClick={() => setAddEdge(null)}>취소</button>
      </div>
     </PanelSection>
    )}

    {/* ── 선택된 노드 편집 ─────────────────────────────────────────── */}
    {selNode && editNode && !addNode && !addEdge && (
     <PanelSection title={`노드 편집`}>
      <Field label="node_id">
       <input
        className={`${INP} ${editNode.node_id !== selNode.node_id ? "border-indigo-400/60 text-indigo-800" : ""}`}
        value={editNode.node_id}
        onChange={e => setEditNode(d => d && ({ ...d, node_id: e.target.value }))}
       />
       {editNode.node_id !== selNode.node_id && (
        <div className="text-[9px] text-indigo-600 mt-0.5">ID 변경 (저장 시 cascade 적용)</div>
       )}
      </Field>
      <Field label="타입">
       <select className={SEL} value={editNode.type} onChange={e => setEditNode(d => d && ({ ...d, type: e.target.value as FNode["type"] }))}>
        <option value="WAYPOINT">WAYPOINT</option>
        <option value="STATION">STATION</option>
        <option value="CHARGER">CHARGER</option>
       </select>
      </Field>
      <Field label="x (m)">
       <input className={INP} type="number" step="0.001" value={editNode.x} onChange={e => setEditNode(d => d && ({ ...d, x: +e.target.value }))} />
      </Field>
      <Field label="y (m)">
       <input className={INP} type="number" step="0.001" value={editNode.y} onChange={e => setEditNode(d => d && ({ ...d, y: +e.target.value }))} />
      </Field>
      <Field label="yaw (rad)">
       <input className={INP} type="number" step="0.01" value={editNode.yaw} onChange={e => setEditNode(d => d && ({ ...d, yaw: +e.target.value }))} />
      </Field>
      <div className="text-[10px] text-white/[0.55] mt-1 mb-1">드래그로 위치를 변경할 수 있습니다</div>
      <div className="flex gap-1 mt-1">
       <button className={BTN("bg-blue-900/40 text-white/[0.82] border-white/[0.1] hover:bg-blue-800/50 flex-1")} onClick={updateNode}>저장</button>
       <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1] hover:bg-red-800/50 flex-1")} onClick={deleteNode}>삭제</button>
      </div>
      <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90 w-full mt-1")} onClick={() => { setSelNodeId(null); setEditNode(null); }}>선택 해제</button>
     </PanelSection>
    )}

    {/* ── 선택된 엣지 편집 ─────────────────────────────────────────── */}
    {selEdge && editEdge && !addNode && !addEdge && (
     <PanelSection title={`엣지 편집`}>
      <Field label="edge_id">
       <input
        className={`${INP} ${editEdge.edge_id !== selEdge.edge_id ? "border-indigo-400/60 text-indigo-800" : ""}`}
        value={editEdge.edge_id}
        onChange={e => setEditEdge(d => d && ({ ...d, edge_id: e.target.value }))}
       />
       {editEdge.edge_id !== selEdge.edge_id && (
        <div className="text-[9px] text-indigo-600 mt-0.5">ID 변경</div>
       )}
      </Field>
      <div className="text-xs text-white/[0.68] mb-2 font-mono">
       {selEdge.startNode} → {selEdge.endNode}
      </div>
      <Field label="방향">
       <select className={SEL} value={editEdge.direction} onChange={e => setEditEdge(d => d && ({ ...d, direction: e.target.value as FEdge["direction"] }))}>
        <option value="BOTH_WAY">BOTH_WAY</option>
        <option value="ONE_WAY">ONE_WAY</option>
       </select>
      </Field>
      <Field label="잠금">
       <button
        onClick={toggleLock}
        className={`px-2 py-1 text-xs font-bold rounded border w-full ${
         editEdge.isLocked
          ? "bg-red-900/40 text-white/[0.82] border-white/[0.1]"
          : "bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90"
        }`}
       >{editEdge.isLocked ? "잠김 — 클릭으로 해제" : "열림 — 클릭으로 잠금"}</button>
      </Field>
      <Field label="가중치">
       <input className={INP} type="number" step="1" value={editEdge.weight ?? 1} onChange={e => setEditEdge(d => d && ({ ...d, weight: +e.target.value }))} />
      </Field>
      <div className="flex gap-1 mt-2">
       <button className={BTN("bg-blue-900/40 text-white/[0.82] border-white/[0.1] hover:bg-blue-800/50 flex-1")} onClick={updateEdge}>저장</button>
       <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1] hover:bg-red-800/50 flex-1")} onClick={deleteEdge}>삭제</button>
      </div>
      <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90 w-full mt-1")} onClick={() => { setSelEdgeId(null); setEditEdge(null); }}>선택 해제</button>
     </PanelSection>
    )}

    {/* 기본 안내 */}
    {!addNode && !addEdge && !selNode && !selEdge && selMap && (
     <div className="px-3 py-4 text-xs text-white/[0.55] leading-relaxed space-y-1">
      {mode === "select" && (
       <>
        <div>• 노드/엣지 클릭 → 선택 및 편집</div>
        <div>• 노드 드래그 → 위치 이동</div>
       </>
      )}
      {mode === "node" && <div>• 맵 빈 공간을 클릭해 노드를 추가하세요</div>}
      {mode === "edge" && <div>• 출발 노드를 클릭한 뒤 도착 노드를 클릭하세요</div>}
     </div>
    )}
   </div>
  </div>
 );
}
