import { useState, useEffect, useCallback } from "react";
import TopologyMapView from "../../components/TopologyMapView";
import { taskStatusKo, TASK_STATUS_KO } from "../../utils/statusLabel";
import { api } from "./api";
import { TH, TD, INP, SEL, BTN, TASK_STATUS_COLOR, TASK_TYPE_COLOR } from "./styles";
import { SectionHeader, ErrBar, TableWrap } from "./common";
import type { Task, TaskType, TaskStatus } from "./types";

export function TaskSection() {
 const [tasks, setTasks] = useState<Task[]>([]);
 const [loading, setLoading] = useState(false);
 const [statusFilter, setStatusFilter] = useState("");
 const [mapPreview, setMapPreview] = useState("");
 const [maps, setMaps] = useState<string[]>([]);
 const [adding, setAdding] = useState(false);
 const [addDraft, setAddDraft] = useState({ type: "SUPPLY" as TaskType, targetNode: "", priority: 5 });
 const [delConfirm, setDelConfirm] = useState<string | null>(null);
 const [cancelConfirm, setCancelConfirm] = useState<string | null>(null);
 const [err, setErr] = useState("");

 useEffect(() => {
 api<{ map_id: string }[]>("/api/fleet/maps")
 .then(ms => setMaps(ms.map(m => m.map_id)))
 .catch(() => {});
 }, []);

 const load = useCallback(async () => {
 setLoading(true);
 try {
 setTasks(await api<Task[]>("/api/fms/tasks" + (statusFilter ? `?status=${statusFilter}` : "") + (!statusFilter ? "?limit=100" : "&limit=100")));
 } catch (e) { setErr(`태스크 로드 실패: ${String(e)}`); }
 setLoading(false);
 }, [statusFilter]);

 useEffect(() => { void load(); }, [load]);

 async function add() {
 if (!addDraft.targetNode) { setErr("targetNode 필수"); return; }
 try {
 await api("/api/fms/tasks", { method: "POST", body: JSON.stringify(addDraft) });
 setAdding(false);
 setAddDraft({ type: "SUPPLY", targetNode: "", priority: 5 });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 async function cancelTask(id: string) {
 try {
 await api(`/api/fms/tasks/${id}/cancel`, { method: "DELETE" });
 setCancelConfirm(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function deleteTask(id: string) {
 try {
 await api(`/api/fms/tasks/${id}`, { method: "DELETE" });
 setDelConfirm(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 return (
 <div className="flex gap-4 items-start">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-3 mb-2">
 <SectionHeader title="태스크" count={tasks.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
 <select className={`${SEL} w-40`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
 <option value="">전체 상태</option>
 {(["PENDING","ASSIGNED","RUNNING","COMPLETED","FAILED"] as TaskStatus[]).map(s => <option key={s} value={s}>{TASK_STATUS_KO[s] ?? s}</option>)}
 </select>
 <select className={`${SEL} w-40`} value={mapPreview} onChange={e => setMapPreview(e.target.value)}>
 <option value="">맵 미리보기…</option>
 {maps.map(m => <option key={m} value={m}>{m}</option>)}
 </select>
 </div>
 {err && <ErrBar msg={err} onClose={() => setErr("")} />}
 <TableWrap>
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["task_id","타입","상태","우선순위","목표 노드","로봇","생성일",""].map(h => <th key={h} className={TH}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {adding && (
 <tr className="border-b border-white/[0.1] bg-[#FFCE99]/32">
 <td className={TD}><span className="text-white/[0.6] text-xs">자동 생성</span></td>
 <td className={TD}>
 <select className={SEL} value={addDraft.type} onChange={e => setAddDraft(d => ({ ...d, type: e.target.value as TaskType }))}>
 {(["SUPPLY","PROCESS","CHARGE","MOVE"] as TaskType[]).map(t => <option key={t}>{t}</option>)}
 </select>
 </td>
 <td className={TD}><span className="text-white/90 text-xs">대기 중</span></td>
 <td className={TD}>
 <input className={`${INP} w-16`} type="number" min={1} max={10} value={addDraft.priority} onChange={e => setAddDraft(d => ({ ...d, priority: +e.target.value }))} />
 </td>
 <td className={TD}>
 <input className={INP} placeholder="N01" value={addDraft.targetNode} onChange={e => setAddDraft(d => ({ ...d, targetNode: e.target.value }))} />
 </td>
 <td className={TD}><span className="text-white/[0.6]">—</span></td>
 <td className={TD}><span className="text-white/[0.6]">—</span></td>
 <td className={TD}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={add}>생성</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setAdding(false)}>취소</button>
 </div>
 </td>
 </tr>
 )}
 {tasks.length === 0 && !adding && (
 <tr><td colSpan={8} className="px-3 py-6 text-center text-white/[0.55] text-xs">태스크 없음</td></tr>
 )}
 {tasks.map(t => (
 <tr key={t._id} className="border-b border-white/[0.1] hover:bg-white/10 transition-colors">
 <td className={`${TD} text-xs text-white/[0.68]`}>{t.task_id.slice(0, 18)}</td>
 <td className={TD}><span className={`px-1.5 py-0.5 text-xs font-bold border rounded ${TASK_TYPE_COLOR[t.type]}`}>{t.type}</span></td>
 <td className={TD}><span className={`font-bold text-xs ${TASK_STATUS_COLOR[t.status]}`}>{taskStatusKo(t.status)}</span></td>
 <td className={TD}><span className="text-white/[0.75]">P{t.priority}</span></td>
 <td className={TD}>{t.targetNode}</td>
 <td className={TD}>{(t as any).assignedRobotId ?? <span className="text-white/[0.6]">—</span>}</td>
 <td className={`${TD} text-white/[0.68] text-xs`}>{new Date(t.createdAt).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" })}</td>
 <td className={TD}>
 {delConfirm === t._id ? (
 <div className="flex gap-1 items-center">
 <span className="text-white/90 text-xs">영구삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => deleteTask(t._id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setDelConfirm(null)}>취소</button>
 </div>
 ) : cancelConfirm === t._id ? (
 <div className="flex gap-1 items-center">
 <span className="text-orange-600 text-xs">취소?</span>
 <button className={BTN("bg-orange-900/40 text-orange-700 border-orange-800/60")} onClick={() => cancelTask(t._id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setCancelConfirm(null)}>취소</button>
 </div>
 ) : (
 <div className="flex gap-1">
 {(t.status === "PENDING" || t.status === "ASSIGNED" || t.status === "RUNNING") && (
 <button className={BTN("bg-[#FFCE99]/32 text-orange-800 border-[#521C0D]/15 hover:text-orange-600")} onClick={() => setCancelConfirm(t._id)}>취소</button>
 )}
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(t._id)}>삭제</button>
 </div>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </TableWrap>
 </div>

 {/* 맵 미리보기 */}
 {mapPreview && (
 <div className="w-[420px] flex-none sticky top-0">
 <div className="text-xs text-white/[0.6] tracking-wide mb-1 ">{mapPreview}</div>
 <TopologyMapView mapId={mapPreview} className="h-[420px]" />
 </div>
 )}
 </div>
 );
}
