import { useState, useEffect, useCallback } from "react";
import { robotStatusKo, ROBOT_STATUS_KO, robotStatusColor, robotStatusDot } from "../../utils/statusLabel";
import { api } from "./api";
import { TH, TD, INP, SEL, BTN } from "./styles";
import { SectionHeader, ErrBar, TableWrap } from "./common";
import { usePolling } from "./usePolling";
import type { Robot, RobotStatus } from "./types";

export function RobotSection() {
 const [robots, setRobots] = useState<Robot[]>([]);
 const [loading] = useState(false);
 const [editId, setEditId] = useState<string | null>(null);
 const [editDraft, setEditDraft] = useState<{ newId: string; ip: string; ros_domain_id: number; status: RobotStatus }>({ newId: "", ip: "", ros_domain_id: 0, status: "IDLE" });
 const [adding, setAdding] = useState(false);
 const [addDraft, setAddDraft] = useState({ robot_id: "", ip: "", ros_domain_id: 0 });
 const [err, setErr] = useState("");
 const [delConfirm, setDelConfirm] = useState<string | null>(null);

 // 항상 DB에서 받아와 새로 그린다 (소켓 표시값 대신 DB가 진실의 원천)
 const load = useCallback(async () => {
 try { setRobots(await api<Robot[]>("/api/fleet/robots")); } catch (e) { setErr(`로봇 로드 실패: ${String(e)}`); }
 }, []);

 // 로우 한 줄만 DB에서 다시 읽어 즉시 반영
 const refreshRow = useCallback(async (id: string) => {
 try {
 const fresh = await api<Robot>(`/api/fleet/robots/${id}`);
 setRobots(prev => prev.map(x => x.robot_id === id ? fresh : x));
 } catch (e) { setErr(String(e)); }
 }, []);

 useEffect(() => { void load(); }, [load]);           // 마운트(탭 전환) 시 즉시 DB 재조회
 usePolling(load, 2000, !editId && !adding);          // 편집 중이 아니면 2초마다 DB 재조회 → test-bot 등 변경 즉시 반영

 async function save() {
 if (!editId) return;
 try {
 if (editDraft.newId && editDraft.newId !== editId) {
 await api(`/api/fleet/robots/${editId}/rename`, { method: "PATCH", body: JSON.stringify({ new_id: editDraft.newId }) });
 const updatedId = editDraft.newId;
 await api(`/api/fleet/robots/${updatedId}`, { method: "PATCH", body: JSON.stringify({ ip: editDraft.ip, ros_domain_id: editDraft.ros_domain_id, status: editDraft.status }) });
 } else {
 await api(`/api/fleet/robots/${editId}`, { method: "PATCH", body: JSON.stringify({ ip: editDraft.ip, ros_domain_id: editDraft.ros_domain_id, status: editDraft.status }) });
 }
 setEditId(null);
 await load();   // 저장 후 즉시 DB 재조회 (이후 폴링이 계속 최신 유지)
 } catch (e) { setErr(String(e)); }
 }

 async function add() {
 if (!addDraft.robot_id || !addDraft.ip) { setErr("robot_id와 ip는 필수입니다"); return; }
 try {
 await api("/api/fleet/robots", { method: "POST", body: JSON.stringify(addDraft) });
 setAdding(false);
 setAddDraft({ robot_id: "", ip: "", ros_domain_id: 0 });
 void load();
 } catch (e) { setErr(String(e)); }
 }

 async function del(id: string) {
 try {
 await api(`/api/fleet/robots/${id}`, { method: "DELETE" });
 setDelConfirm(null);
 void load();
 } catch (e) { setErr(String(e)); }
 }

 function startEdit(r: Robot) {
 setEditId(r.robot_id);
 setEditDraft({ newId: r.robot_id, ip: r.ip, ros_domain_id: r.ros_domain_id, status: r.status });
 setErr("");
 }

 return (
 <div>
 <SectionHeader title="로봇 등록부" count={robots.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} />
 {err && <ErrBar msg={err} onClose={() => setErr("")} />}
 <TableWrap>
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["robot_id","ip","도메인 ID","상태","맵","노드",""].map(h => <th key={h} className={TH}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {adding && (
 <tr className="border-b border-white/[0.1] bg-[#FFCE99]/32">
 <td className={TD}><input className={INP} placeholder="tb3_01" value={addDraft.robot_id} onChange={e => setAddDraft(d => ({ ...d, robot_id: e.target.value }))} /></td>
 <td className={TD}><input className={INP} placeholder="192.168.0.10" value={addDraft.ip} onChange={e => setAddDraft(d => ({ ...d, ip: e.target.value }))} /></td>
 <td className={TD}><input className={INP} type="number" value={addDraft.ros_domain_id} onChange={e => setAddDraft(d => ({ ...d, ros_domain_id: +e.target.value }))} /></td>
 <td className={TD} colSpan={3}><span className="text-white/[0.6]">—</span></td>
 <td className={TD}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1] hover:bg-green-800/50")} onClick={add}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90")} onClick={() => setAdding(false)}>취소</button>
 </div>
 </td>
 </tr>
 )}
 {robots.length === 0 && !adding && (
 <tr><td colSpan={7} className="px-3 py-6 text-center text-white/[0.55] text-xs">등록된 로봇이 없습니다</td></tr>
 )}
 {robots.map(r => {
 const isEdit = editId === r.robot_id;
 const idChanged = isEdit && editDraft.newId !== r.robot_id;
 return (
 <tr key={r.robot_id} className={`border-b border-white/[0.1] hover:bg-white/10 transition-colors ${isEdit ? "bg-indigo-950/20" : ""}`}>
 <td className={TD}>
 {isEdit ? (
 <div className="flex items-center gap-1">
 <input className={`${INP} w-28 ${idChanged ? "border-indigo-400/60 text-indigo-800" : ""}`}
 value={editDraft.newId} onChange={e => setEditDraft(d => ({ ...d, newId: e.target.value }))} autoFocus />
 {idChanged && <span className="text-[9px] bg-indigo-500/20 text-indigo-700 px-1 py-0.5 rounded whitespace-nowrap">ID변경</span>}
 </div>
 ) : r.robot_id}
 </td>
 <td className={TD}>
 {isEdit
 ? <input className={INP} value={editDraft.ip} onChange={e => setEditDraft(d => ({ ...d, ip: e.target.value }))} />
 : r.ip}
 </td>
 <td className={TD}>
 {isEdit
 ? <input className={INP} type="number" value={editDraft.ros_domain_id} onChange={e => setEditDraft(d => ({ ...d, ros_domain_id: +e.target.value }))} />
 : r.ros_domain_id}
 </td>
 <td className={TD}>
 {isEdit
 ? <select className={SEL} value={editDraft.status} onChange={e => setEditDraft(d => ({ ...d, status: e.target.value as RobotStatus }))}>
 {(["IDLE","RETURNING","PAUSED","WORKING","TO_CHARGE","CHARGING","PARKED","TO_LOAD","LOADING","LOADED","UNLOADING","CARRIER_UP","CARRIER_DOWN","ERROR","OFFLINE"] as RobotStatus[]).map(s => <option key={s} value={s}>{ROBOT_STATUS_KO[s] ?? s}</option>)}
 </select>
 : (
 <span className="inline-flex items-center gap-1.5">
 <span className={`w-1.5 h-1.5 rounded-full ${robotStatusDot(r.status)}`} title="DB (2초마다 갱신)" />
 <span className={`font-bold ${robotStatusColor(r.status)}`}>{robotStatusKo(r.status)}</span>
 </span>
 )}
 </td>
 <td className={TD}>{r.location ?? <span className="text-white/[0.6]">—</span>}</td>
 <td className={TD}>{r.lastNode ?? <span className="text-white/[0.6]">—</span>}</td>
 <td className={TD}>
 {delConfirm === r.robot_id ? (
 <div className="flex gap-1 items-center">
 <span className="text-white/90 text-xs">삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1] hover:bg-red-800/50")} onClick={() => del(r.robot_id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(null)}>취소</button>
 </div>
 ) : isEdit ? (
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1] hover:bg-green-800/50")} onClick={save}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90")} onClick={() => setEditId(null)}>취소</button>
 </div>
 ) : (
 <div className="flex gap-1">
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.6] border-white/[0.1] hover:text-white/90")} title="이 행만 새로고침" onClick={() => refreshRow(r.robot_id)}>↻</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.75] border-white/[0.1] hover:text-white/90")} onClick={() => startEdit(r)}>수정</button>
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(r.robot_id)}>삭제</button>
 </div>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </TableWrap>
 </div>
 );
}
