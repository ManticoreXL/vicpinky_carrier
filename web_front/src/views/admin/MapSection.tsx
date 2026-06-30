import { useState, useEffect, useCallback, Fragment } from "react";
import { api } from "./api";
import { TH, TD, INP, BTN } from "./styles";
import { SectionHeader, ErrBar, TableWrap } from "./common";
import { usePolling } from "./usePolling";
import type { FleetMap } from "./types";

export function MapSection() {
 const [maps, setMaps] = useState<FleetMap[]>([]);
 const [loading, setLoading] = useState(false);
 const [adding, setAdding] = useState(false);
 const [addMapId, setAddMapId] = useState("");
 const [expanded, setExpanded] = useState<string | null>(null);
 const [initEdit, setInitEdit] = useState<{ map_id: string; robot_id: string; x: string; y: string; yaw: string } | null>(null);
 const [addInit, setAddInit] = useState<{ map_id: string; robot_id: string; x: string; y: string; yaw: string } | null>(null);
 const [delConfirm, setDelConfirm] = useState<string | null>(null);
 // init_position 삭제 확인: "mapId::robotId"
 const [delInitConfirm, setDelInitConfirm] = useState<string | null>(null);
 const [err, setErr] = useState("");

 const load = useCallback(async () => {
 setLoading(true);
 try { setMaps(await api<FleetMap[]>("/api/fleet/maps")); } catch (e) { setErr(`맵 로드 실패: ${String(e)}`); }
 setLoading(false);
 }, []);

 useEffect(() => { void load(); }, [load]);
 usePolling(load, 2000, !adding && !initEdit && !addInit);   // 항상 DB에서 받아와 새로 그림 (편집 중 제외)

 async function addMap() {
 if (!addMapId.trim()) { setErr("map_id는 필수입니다"); return; }
 try {
 await api("/api/fleet/maps", { method: "POST", body: JSON.stringify({ map_id: addMapId, init_position: {} }) });
 setAdding(false); setAddMapId(""); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function del(id: string) {
 try {
 await api(`/api/fleet/maps/${id}`, { method: "DELETE" });
 setDelConfirm(null); setExpanded(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function saveInitPos(map_id: string, robot_id: string, x: number, y: number, yaw: number) {
 if (!robot_id.trim()) { setErr("robot_id는 필수입니다"); return; }
 try {
 await api(`/api/fleet/maps/${map_id}/init-position/${robot_id}`, {
 method: "PATCH",
 body: JSON.stringify({ x, y, yaw }),
 });
 setInitEdit(null); setAddInit(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 async function deleteInitPos(map_id: string, robot_id: string) {
 try {
 await api(`/api/fleet/maps/${map_id}/init-position/${robot_id}`, { method: "DELETE" });
 setDelInitConfirm(null); void load();
 } catch (e) { setErr(String(e)); }
 }

 return (
 <div>
 <SectionHeader title="Fleet 맵 (DB)" count={maps.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} />
 {err && <ErrBar msg={err} onClose={() => setErr("")} />}
 <TableWrap>
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["map_id","초기위치 로봇 수",""].map(h => <th key={h} className={TH}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {adding && (
 <tr className="border-b border-white/[0.1] bg-[#FFCE99]/32">
 <td className={TD}><input className={INP} placeholder="floor_1" value={addMapId} onChange={e => setAddMapId(e.target.value)} /></td>
 <td className={TD}><span className="text-white/[0.6]">—</span></td>
 <td className={TD}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1] hover:bg-green-800/50")} onClick={addMap}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1] hover:text-white/90")} onClick={() => setAdding(false)}>취소</button>
 </div>
 </td>
 </tr>
 )}
 {maps.length === 0 && !adding && (
 <tr><td colSpan={3} className="px-3 py-6 text-center text-white/[0.55] text-xs">등록된 맵이 없습니다</td></tr>
 )}
 {maps.map(m => {
 const initCount = Object.keys(m.init_position ?? {}).length;
 const isExp = expanded === m.map_id;
 return (
 <Fragment key={m.map_id}>
 <tr key={m.map_id} className={`border-b border-white/[0.1] hover:bg-white/10 transition-colors cursor-pointer ${isExp ? "bg-white/10" : ""}`}
 onClick={() => setExpanded(isExp ? null : m.map_id)}>
 <td className={TD}>
 <span className="mr-1.5 text-white/[0.6]">{isExp ? "▾" : "▸"}</span>
 {m.map_id}
 </td>
 <td className={TD}><span className="text-white/[0.75]">{initCount}개</span></td>
 <td className={TD} onClick={e => e.stopPropagation()}>
 {delConfirm === m.map_id ? (
 <div className="flex gap-1 items-center">
 <span className="text-white/90 text-xs">삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => del(m.map_id)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setDelConfirm(null)}>취소</button>
 </div>
 ) : (
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelConfirm(m.map_id)}>삭제</button>
 )}
 </td>
 </tr>
 {isExp && (
 <tr key={`${m.map_id}-exp`} className="border-b border-white/[0.1] bg-transparent">
 <td colSpan={3} className="px-6 py-3">
 <div className="text-xs text-white/[0.68] tracking-wide mb-2">초기 위치 (init_position)</div>
 <table className="w-full">
 <thead>
 <tr className="border-b border-white/[0.1]">
 {["robot_id","x","y","yaw",""].map(h => <th key={h} className={`${TH} text-xs`}>{h}</th>)}
 </tr>
 </thead>
 <tbody>
 {Object.entries(m.init_position ?? {}).map(([rid, pos]) => {
 const isEd = initEdit?.map_id === m.map_id && initEdit.robot_id === rid;
 const initKey = `${m.map_id}::${rid}`;
 return (
 <tr key={rid} className="border-b border-[#521C0D]/10">
 <td className={`${TD} text-xs`}>{rid}</td>
 {isEd ? (
 <>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} value={initEdit.x} onChange={e => setInitEdit(d => d && ({ ...d, x: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} value={initEdit.y} onChange={e => setInitEdit(d => d && ({ ...d, y: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} value={initEdit.yaw} onChange={e => setInitEdit(d => d && ({ ...d, yaw: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => saveInitPos(m.map_id, rid, +initEdit.x, +initEdit.y, +initEdit.yaw)}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setInitEdit(null)}>취소</button>
 </div>
 </td>
 </>
 ) : delInitConfirm === initKey ? (
 <>
 <td className={`${TD} text-xs`}>{pos.x.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>{pos.y.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>{pos.yaw.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>
 <div className="flex gap-1 items-center">
 <span className="text-white/90">삭제?</span>
 <button className={BTN("bg-red-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => deleteInitPos(m.map_id, rid)}>확인</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setDelInitConfirm(null)}>취소</button>
 </div>
 </td>
 </>
 ) : (
 <>
 <td className={`${TD} text-xs`}>{pos.x.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>{pos.y.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>{pos.yaw.toFixed(3)}</td>
 <td className={`${TD} text-xs`}>
 <div className="flex gap-1">
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.75] border-white/[0.1] hover:text-white/90")} onClick={() => setInitEdit({ map_id: m.map_id, robot_id: rid, x: String(pos.x), y: String(pos.y), yaw: String(pos.yaw) })}>수정</button>
 <button className={BTN("bg-[#FFCE99]/32 text-red-800 border-white/[0.1] hover:text-white/90")} onClick={() => setDelInitConfirm(initKey)}>삭제</button>
 </div>
 </td>
 </>
 )}
 </tr>
 );
 })}
 {/* 추가 행 */}
 {addInit?.map_id === m.map_id ? (
 <tr className="border-b border-[#521C0D]/10 bg-[#FFCE99]/32">
 <td className={`${TD} text-xs`}><input className={`${INP} w-24`} placeholder="tb3_01" value={addInit.robot_id} onChange={e => setAddInit(d => d && ({ ...d, robot_id: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.x} onChange={e => setAddInit(d => d && ({ ...d, x: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.y} onChange={e => setAddInit(d => d && ({ ...d, y: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.yaw} onChange={e => setAddInit(d => d && ({ ...d, yaw: e.target.value }))} /></td>
 <td className={`${TD} text-xs`}>
 <div className="flex gap-1">
 <button className={BTN("bg-green-900/40 text-white/[0.82] border-white/[0.1]")} onClick={() => saveInitPos(m.map_id, addInit.robot_id, +addInit.x, +addInit.y, +addInit.yaw)}>저장</button>
 <button className={BTN("bg-[#FFCE99]/32 text-white/[0.68] border-white/[0.1]")} onClick={() => setAddInit(null)}>취소</button>
 </div>
 </td>
 </tr>
 ) : (
 <tr>
 <td colSpan={5} className="py-1.5 px-2">
 <button className="text-xs text-white/[0.6] hover:text-white/[0.75] transition-colors" onClick={() => setAddInit({ map_id: m.map_id, robot_id: "", x: "0", y: "0", yaw: "0" })}>
 + 초기위치 추가
 </button>
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 </tbody>
 </TableWrap>
 </div>
 );
}
