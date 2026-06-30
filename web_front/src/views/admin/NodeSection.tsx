import { useState, useEffect, useCallback } from "react";
import TopologyMapView from "../../components/TopologyMapView";
import { api } from "./api";
import { TH, TD, INP, SEL, BTN } from "./styles";
import { SectionHeader, ErrBar, TableWrap, NodeTypeBadge } from "./common";
import { usePolling } from "./usePolling";
import type { FleetNode, FleetMap, NodeType } from "./types";

export function NodeSection() {
 const [nodes, setNodes] = useState<FleetNode[]>([]);
 const [loading, setLoading] = useState(false);
 const [mapFilter, setMapFilter] = useState("");
 const [maps, setMaps] = useState<string[]>([]);
 const [editId, setEditId] = useState<string | null>(null);
 const [editDraft, setEditDraft] = useState<{ newId: string; map_id: string; type: NodeType; x: number; y: number; yaw: number }>({ newId: "", map_id: "", type: "WAYPOINT", x: 0, y: 0, yaw: 0 });
 const [adding, setAdding] = useState(false);
 const [addDraft, setAddDraft] = useState<Partial<FleetNode>>({ type: "WAYPOINT", x: 0, y: 0, yaw: 0 });
 const [delConfirm, setDelConfirm] = useState<string | null>(null);
 const [err, setErr] = useState("");

 useEffect(() => {
 api<FleetMap[]>("/api/fleet/maps")
 .then(ms => setMaps(ms.map(m => m.map_id)))
 .catch(() => {});
 }, []);

 const load = useCallback(async () => {
 setLoading(true);
 try {
 const all = await api<FleetNode[]>("/api/fleet/topology/nodes" + (mapFilter ? `?map_id=${mapFilter}` : ""));
 setNodes(all);
 setMaps(prev => [...new Set([...prev, ...all.map(n => n.map_id)])]);
 } catch (e) { setErr(`노드 로드 실패: ${String(e)}`); }
 setLoading(false);
 }, [mapFilter]);

 useEffect(() => { void load(); }, [load]);
 usePolling(load, 2000, !editId && !adding);   // 항상 DB에서 받아와 새로 그림 (편집 중 제외)

 async function save() {
 if (!editId) return;
 try {
 const { newId, ...rest } = editDraft;
 if (newId && newId !== editId) {
 await api(`/api/fleet/topology/nodes/${editId}/rename`, { method: "PATCH", body: JSON.stringify({ new_id: newId }) });
 await api(`/api/fleet/topology/nodes/${newId}`, { method: "PATCH", body: JSON.stringify(rest) });
 } else {
 await api(`/api/fleet/topology/nodes/${editId}`, { method: "PATCH", body: JSON.stringify(rest) });
 }
 setEditId(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function add() {
 if (!addDraft.node_id || !addDraft.map_id || !addDraft.type) { setErr("node_id, map_id, type 필수"); return; }
 try {
 await api("/api/fleet/topology/nodes", { method: "POST", body: JSON.stringify(addDraft) });
 setAdding(false);
 setAddDraft({ type: "WAYPOINT", x: 0, y: 0, yaw: 0 });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 async function del(id: string) {
 try {
 await api(`/api/fleet/topology/nodes/${id}`, { method: "DELETE" });
 setDelConfirm(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function toggleNodeLock(node: FleetNode) {
 try {
 await api(`/api/fleet/topology/nodes/${node.node_id}/lock`, { method: "PATCH", body: JSON.stringify({ isLocked: !node.isLocked }) });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 // 점유 수동 해제 — 충전소 isLocked/isLockedBy 둘 다 비운다
 async function clearOccupancy(node: FleetNode) {
 try {
 await api(`/api/fleet/topology/nodes/${node.node_id}`, { method: "PATCH", body: JSON.stringify({ isLocked: false, isLockedBy: null }) });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 // 초기 위치 토글 — 노드의 initPosition on/off
 async function toggleInitPosition(node: FleetNode) {
 try {
 await api(`/api/fleet/topology/nodes/${node.node_id}`, { method: "PATCH", body: JSON.stringify({ initPosition: !node.initPosition }) });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 function startEdit(n: FleetNode) {
 setEditId(n.node_id);
 setEditDraft({ newId: n.node_id, map_id: n.map_id, type: n.type, x: n.x, y: n.y, yaw: n.yaw });
 setErr("");
 }

 const displayed = mapFilter ? nodes.filter(n => n.map_id === mapFilter) : nodes;

 return (
 <div className="flex gap-4 items-start">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-3 mb-2">
 <SectionHeader title="노드" count={displayed.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
 <select className={`${SEL} w-40`} value={mapFilter} onChange={e => setMapFilter(e.target.value)} onFocus={() => void load()}>
 <option value="">전체 맵</option>
 {maps.map(m => <option key={m} value={m}>{m}</option>)}
 </select>
 </div>
 {err && <ErrBar msg={err} onClose={() => setErr("")} />}
 <TableWrap>
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["node_id","map_id","타입","x","y","yaw","잠금","초기위치","점유(isLockedBy)",""].map(h => <th key={h} className={TH}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {adding && (
 <tr className="border-b border-white/[0.1] bg-[#FFCE99]/32">
 <td className={TD}><input className={INP} placeholder="N01" value={addDraft.node_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, node_id: e.target.value }))} /></td>
 <td className={TD}>
 <input className={INP} placeholder="floor_1" list="node-maps-list" value={addDraft.map_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, map_id: e.target.value }))} />
 <datalist id="node-maps-list">{maps.map(m => <option key={m} value={m} />)}</datalist>
 </td>
 <td className={TD}>
 <select className={SEL} value={addDraft.type} onChange={e => setAddDraft(d => ({ ...d, type: e.target.value as NodeType }))}>
 {(["WAYPOINT","STATION","CHARGER"] as NodeType[]).map(t => <option key={t}>{t}</option>)}
 </select>
 </td>
 <td className={TD}><input className={`${INP} w-20`} type="number" step="0.01" value={addDraft.x ?? 0} onChange={e => setAddDraft(d => ({ ...d, x: +e.target.value }))} /></td>
 <td className={TD}><input className={`${INP} w-20`} type="number" step="0.01" value={addDraft.y ?? 0} onChange={e => setAddDraft(d => ({ ...d, y: +e.target.value }))} /></td>
 <td className={TD}>
 <div className="flex items-center gap-1">
 <input className={`${INP} w-16`} type="number" step="0.01" value={addDraft.yaw ?? 0} onChange={e => setAddDraft(d => ({ ...d, yaw: +e.target.value }))} />
 <span className="text-white/[0.6] text-xs whitespace-nowrap">{((addDraft.yaw ?? 0) * 180 / Math.PI).toFixed(0)}°</span>
 </div>
 </td>
 <td className={TD} />
 <td className={TD}>
 <label className="flex items-center gap-1 text-xs text-white/[0.7] whitespace-nowrap">
 <input type="checkbox" checked={!!addDraft.initPosition} onChange={e => setAddDraft(d => ({ ...d, initPosition: e.target.checked }))} /> 초기
 </label>
 </td>
 <td className={TD} />
 <td className={TD}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={add}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setAdding(false)}>취소</button>
 </div>
 </td>
 </tr>
 )}
 {displayed.length === 0 && !adding && (
 <tr><td colSpan={10} className="px-3 py-6 text-center text-white/[0.55] text-xs">노드 없음</td></tr>
 )}
 {displayed.map(n => {
 const isEdit = editId === n.node_id;
 const d = editDraft;
 const idChanged = isEdit && d.newId !== n.node_id;
 return (
 <tr key={n.node_id} className={`border-b border-white/[0.1] hover:bg-white/10 transition-colors ${isEdit ? "bg-indigo-950/20" : n.isLocked ? "bg-red-950/10" : ""}`}>
 <td className={TD}>
 {isEdit ? (
 <div className="flex items-center gap-1">
 <input className={`${INP} w-24 ${idChanged ? "border-indigo-400/60 text-indigo-800" : ""}`}
 value={d.newId} onChange={e => setEditDraft(p => ({ ...p, newId: e.target.value }))} autoFocus />
 {idChanged && <span className="text-[9px] bg-indigo-500/20 text-indigo-700 px-1 py-0.5 rounded whitespace-nowrap">ID변경</span>}
 </div>
 ) : n.node_id}
 </td>
 <td className={TD}>{isEdit ? <input className={INP} value={d.map_id} onChange={e => setEditDraft(p => ({ ...p, map_id: e.target.value }))} /> : n.map_id}</td>
 <td className={TD}>{isEdit
 ? <select className={SEL} value={d.type} onChange={e => setEditDraft(p => ({ ...p, type: e.target.value as NodeType }))}>{(["WAYPOINT","STATION","CHARGER"] as NodeType[]).map(t => <option key={t}>{t}</option>)}</select>
 : <NodeTypeBadge type={n.type} />}
 </td>
 <td className={TD}>{isEdit ? <input className={`${INP} w-20`} type="number" step="0.01" value={d.x} onChange={e => setEditDraft(p => ({ ...p, x: +e.target.value }))} /> : n.x.toFixed(3)}</td>
 <td className={TD}>{isEdit ? <input className={`${INP} w-20`} type="number" step="0.01" value={d.y} onChange={e => setEditDraft(p => ({ ...p, y: +e.target.value }))} /> : n.y.toFixed(3)}</td>
 <td className={TD}>{isEdit ? (
 <div className="flex items-center gap-1">
 <input className={`${INP} w-16`} type="number" step="0.01" value={d.yaw} onChange={e => setEditDraft(p => ({ ...p, yaw: +e.target.value }))} />
 <span className="text-white/[0.6] text-xs whitespace-nowrap">{(d.yaw * 180 / Math.PI).toFixed(0)}°</span>
 </div>
 ) : <span>{n.yaw.toFixed(3)}<span className="text-white/[0.55] ml-1">{(n.yaw * 180 / Math.PI).toFixed(0)}°</span></span>}</td>
 <td className={TD}>
 <button className={`px-2 py-0.5 text-xs font-bold rounded border transition-colors ${n.isLocked ? "bg-red-900/40 text-white/[0.82] border-white/[0.1] hover:bg-red-800/50" : "bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90"}`}
 onClick={() => toggleNodeLock(n)}>{n.isLocked ? "잠김" : "열림"}</button>
 </td>
 <td className={TD}>
 <button className={`px-2 py-0.5 text-xs font-bold rounded border transition-colors ${n.initPosition ? "bg-amber-500/30 text-white/[0.9] border-amber-400/40 hover:bg-amber-500/40" : "bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1] hover:text-white/90"}`}
 onClick={() => toggleInitPosition(n)}>{n.initPosition ? "✓ 설정됨" : "설정"}</button>
 </td>
 <td className={TD}>
 {n.isLockedBy ? (
  <div className="flex items-center gap-1">
   <span className="px-2 py-0.5 text-xs font-bold rounded border bg-emerald-900/40 text-white/[0.82] border-white/[0.1] whitespace-nowrap">⚡ {n.isLockedBy}</span>
   <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} title="점유 수동 해제" onClick={() => clearOccupancy(n)}>해제</button>
  </div>
 ) : <span className="text-white/[0.4]">—</span>}
 </td>
 <td className={TD}>
 {delConfirm === n.node_id ? (
 <div className="flex gap-1 items-center">
 <span className="text-white/90 text-xs">삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => del(n.node_id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setDelConfirm(null)}>취소</button>
 </div>
 ) : isEdit ? (
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={save}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setEditId(null)}>취소</button>
 </div>
 ) : (
 <div className="flex gap-1">
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.75] border-white/[0.1] hover:text-white/90")} onClick={() => startEdit(n)}>수정</button>
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(n.node_id)}>삭제</button>
 </div>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </TableWrap>
 </div>

 {mapFilter && (
 <div className="w-[420px] flex-none sticky top-0">
 <div className="text-xs text-white/[0.6] tracking-wide mb-1 ">{mapFilter}</div>
 <TopologyMapView mapId={mapFilter} className="h-[420px]" />
 </div>
 )}
 </div>
 );
}
