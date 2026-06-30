import { useState, useEffect, useCallback } from "react";
import TopologyMapView from "../../components/TopologyMapView";
import { api } from "./api";
import { TH, TD, INP, SEL, BTN } from "./styles";
import { SectionHeader, ErrBar, TableWrap } from "./common";
import { usePolling } from "./usePolling";
import type { FleetEdge, FleetNode, EdgeDirection } from "./types";

export function EdgeSection() {
 const [edges, setEdges] = useState<FleetEdge[]>([]);
 const [allNodes, setAllNodes] = useState<FleetNode[]>([]);
 const [loading, setLoading] = useState(false);
 const [mapFilter, setMapFilter] = useState("");
 const [editId, setEditId] = useState<string | null>(null);
 const [editDraft, setEditDraft] = useState<{ newId: string; map_id: string; startNode: string; endNode: string; direction: EdgeDirection; weight: number }>({ newId: "", map_id: "", startNode: "", endNode: "", direction: "BOTH_WAY", weight: 1 });
 const [adding, setAdding] = useState(false);
 const [addDraft, setAddDraft] = useState<Partial<FleetEdge>>({ direction: "BOTH_WAY", isLocked: false });
 const [delConfirm, setDelConfirm] = useState<string | null>(null);
 const [err, setErr] = useState("");

 const loadNodes = useCallback(() => {
 api<FleetNode[]>("/api/fleet/topology/nodes")
 .then(ns => setAllNodes(ns))
 .catch(() => {});
 }, []);

 const load = useCallback(async () => {
 setLoading(true);
 try {
 const all = await api<FleetEdge[]>("/api/fleet/topology/edges" + (mapFilter ? `?map_id=${mapFilter}` : ""));
 setEdges(all);
 } catch (e) { setErr(`엣지 로드 실패: ${String(e)}`); }
 setLoading(false);
 }, [mapFilter]);

 useEffect(() => { void load(); loadNodes(); }, [load, loadNodes]);
 usePolling(load, 2000, !editId && !adding);   // 항상 DB에서 받아와 새로 그림 (편집 중 제외)

 const nodeMaps = [...new Set(allNodes.map(n => n.map_id))].sort();
 const nodesForMap = (mapId: string) => allNodes.filter(n => n.map_id === mapId);

 async function save() {
 if (!editId) return;
 try {
 const { newId, ...rest } = editDraft;
 if (newId && newId !== editId) {
 await api(`/api/fleet/topology/edges/${editId}/rename`, { method: "PATCH", body: JSON.stringify({ new_id: newId }) });
 await api(`/api/fleet/topology/edges/${newId}`, { method: "PATCH", body: JSON.stringify(rest) });
 } else {
 await api(`/api/fleet/topology/edges/${editId}`, { method: "PATCH", body: JSON.stringify(rest) });
 }
 setEditId(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function add() {
 if (!addDraft.edge_id || !addDraft.map_id || !addDraft.startNode || !addDraft.endNode) {
 setErr("edge_id, 맵, 출발 노드, 도착 노드 필수"); return;
 }
 if (addDraft.startNode === addDraft.endNode) {
 setErr("출발 노드와 도착 노드가 같을 수 없습니다"); return;
 }
 try {
 await api("/api/fleet/topology/edges", { method: "POST", body: JSON.stringify(addDraft) });
 setAdding(false);
 setAddDraft({ direction: "BOTH_WAY", isLocked: false });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 async function del(id: string) {
 try {
 await api(`/api/fleet/topology/edges/${id}`, { method: "DELETE" });
 setDelConfirm(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function toggleLock(edge: FleetEdge) {
 try {
 await api(`/api/fleet/topology/edges/${edge.edge_id}/lock`, { method: "PATCH", body: JSON.stringify({ isLocked: !edge.isLocked }) });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 function startEdit(e: FleetEdge) {
 setEditId(e.edge_id);
 setEditDraft({ newId: e.edge_id, map_id: e.map_id, startNode: e.startNode, endNode: e.endNode, direction: e.direction, weight: e.weight ?? 1 });
 setErr("");
 }

 const displayed = mapFilter ? edges.filter(e => e.map_id === mapFilter) : edges;
 const NSEL = `${SEL} min-w-[80px]`;

 return (
 <div className="flex gap-4 items-start">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-3 mb-2">
 <SectionHeader title="엣지" count={displayed.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
 <select className={`${SEL} w-40`} value={mapFilter} onChange={e => setMapFilter(e.target.value)} onFocus={() => void load()}>
 <option value="">전체 맵</option>
 {nodeMaps.map(m => <option key={m} value={m}>{m}</option>)}
 </select>
 </div>
 {err && <ErrBar msg={err} onClose={() => setErr("")} />}
 <TableWrap>
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["edge_id","맵","출발 → 도착","방향","가중치","잠금",""].map(h => <th key={h} className={TH}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {adding && (
 <tr className="border-b border-white/[0.1] bg-[#FFCE99]/32">
 <td className={TD}><input className={INP} placeholder="E01" value={addDraft.edge_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, edge_id: e.target.value }))} /></td>
 <td className={TD}>
 <select className={NSEL} value={addDraft.map_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, map_id: e.target.value, startNode: "", endNode: "" }))}>
 <option value="">맵 선택</option>
 {nodeMaps.map(m => <option key={m} value={m}>{m}</option>)}
 </select>
 </td>
 <td className={TD}>
 <div className="flex items-center gap-1">
 <select className={NSEL} value={addDraft.startNode ?? ""} disabled={!addDraft.map_id}
 onChange={e => setAddDraft(d => ({ ...d, startNode: e.target.value, endNode: d.endNode === e.target.value ? "" : d.endNode }))}>
 <option value="">출발</option>
 {nodesForMap(addDraft.map_id ?? "").map(n => (
 <option key={n.node_id} value={n.node_id}>{n.node_id}</option>
 ))}
 </select>
 <span className="text-white/[0.6]">→</span>
 <select className={NSEL} value={addDraft.endNode ?? ""} disabled={!addDraft.startNode}
 onChange={e => setAddDraft(d => ({ ...d, endNode: e.target.value }))}>
 <option value="">도착</option>
 {nodesForMap(addDraft.map_id ?? "").filter(n => n.node_id !== addDraft.startNode).map(n => (
 <option key={n.node_id} value={n.node_id}>{n.node_id}</option>
 ))}
 </select>
 </div>
 </td>
 <td className={TD}>
 <select className={SEL} value={addDraft.direction} onChange={e => setAddDraft(d => ({ ...d, direction: e.target.value as EdgeDirection }))}>
 <option value="BOTH_WAY">BOTH_WAY</option>
 <option value="ONE_WAY">ONE_WAY</option>
 </select>
 </td>
 <td className={TD}>
 <input className={`${INP} w-16`} type="number" step="1" placeholder="1" value={addDraft.weight ?? ""} onChange={e => setAddDraft(d => ({ ...d, weight: +e.target.value }))} />
 </td>
 <td className={TD}><span className="text-white/[0.6]">—</span></td>
 <td className={TD}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={add}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => { setAdding(false); setAddDraft({ direction: "BOTH_WAY", isLocked: false }); }}>취소</button>
 </div>
 </td>
 </tr>
 )}
 {displayed.length === 0 && !adding && (
 <tr><td colSpan={6} className="px-3 py-6 text-center text-white/[0.55] text-xs">엣지 없음</td></tr>
 )}
 {displayed.map(e => {
 const isEdit = editId === e.edge_id;
 const d = editDraft;
 const idChanged = isEdit && d.newId !== e.edge_id;
 return (
 <tr key={e.edge_id} className={`border-b border-white/[0.1] hover:bg-white/10 transition-colors ${isEdit ? "bg-indigo-950/20" : ""}`}>
 <td className={TD}>
 {isEdit ? (
 <div className="flex items-center gap-1">
 <input className={`${INP} w-24 ${idChanged ? "border-indigo-400/60 text-indigo-800" : ""}`}
 value={d.newId} onChange={ev => setEditDraft(p => ({ ...p, newId: ev.target.value }))} autoFocus />
 {idChanged && <span className="text-[9px] bg-indigo-500/20 text-indigo-700 px-1 py-0.5 rounded whitespace-nowrap">ID변경</span>}
 </div>
 ) : e.edge_id}
 </td>
 <td className={TD}>{e.map_id}</td>
 <td className={TD}>
 {isEdit ? (
 <div className="flex items-center gap-1">
 <select className={NSEL} value={d.startNode}
 onChange={ev => setEditDraft(p => ({ ...p, startNode: ev.target.value, endNode: p.endNode === ev.target.value ? "" : p.endNode }))}>
 {nodesForMap(d.map_id).map(n => (
 <option key={n.node_id} value={n.node_id}>{n.node_id}</option>
 ))}
 </select>
 <span className="text-white/[0.6]">→</span>
 <select className={NSEL} value={d.endNode}
 onChange={ev => setEditDraft(p => ({ ...p, endNode: ev.target.value }))}>
 {nodesForMap(d.map_id).filter(n => n.node_id !== d.startNode).map(n => (
 <option key={n.node_id} value={n.node_id}>{n.node_id}</option>
 ))}
 </select>
 </div>
 ) : (
 <span><span className="text-white/90">{e.startNode}</span><span className="text-white/[0.6] mx-1">→</span><span className="text-white/90">{e.endNode}</span></span>
 )}
 </td>
 <td className={TD}>
 {isEdit
 ? <select className={SEL} value={d.direction} onChange={ev => setEditDraft(p => ({ ...p, direction: ev.target.value as EdgeDirection }))}><option value="BOTH_WAY">BOTH_WAY</option><option value="ONE_WAY">ONE_WAY</option></select>
 : <span className={e.direction === "BOTH_WAY" ? "text-white/90" : "text-yellow-600"}>{e.direction}</span>}
 </td>
 <td className={TD}>
 {isEdit
 ? <input className={`${INP} w-16`} type="number" step="1" value={d.weight} onChange={ev => setEditDraft(p => ({ ...p, weight: +ev.target.value }))} />
 : <span className="text-white/[0.75]">{e.weight ?? 1}</span>}
 </td>
 <td className={TD}>
 <button
 className={`px-2 py-0.5 text-xs font-bold rounded border transition-colors ${e.isLocked ? "bg-red-900/40 text-white/[0.82] border-white/[0.1] hover:bg-red-800/50" : "bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90"}`}
 onClick={() => toggleLock(e)}
 >{e.isLocked ? "잠김" : "열림"}</button>
 </td>
 <td className={TD}>
 {delConfirm === e.edge_id ? (
 <div className="flex gap-1 items-center">
 <span className="text-white/90 text-xs">삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => del(e.edge_id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setDelConfirm(null)}>취소</button>
 </div>
 ) : isEdit ? (
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={save}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setEditId(null)}>취소</button>
 </div>
 ) : (
 <div className="flex gap-1">
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.75] border-white/[0.1] hover:text-white/90")} onClick={() => startEdit(e)}>수정</button>
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(e.edge_id)}>삭제</button>
 </div>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </TableWrap>
 </div>

 {/* 맵 미리보기 */}
 {mapFilter && (
 <div className="w-[420px] flex-none sticky top-0">
 <div className="text-xs text-white/[0.6] tracking-wide mb-1 ">{mapFilter}</div>
 <TopologyMapView mapId={mapFilter} className="h-[420px]" />
 </div>
 )}
 </div>
 );
}
