import { useState, useEffect, useCallback, Fragment } from "react";
import { useNestSocket } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import TopologyEditor from "./TopologyEditor";

// ── 타입 ─────────────────────────────────────────────────────────────────────

type RobotStatus   = "IDLE" | "MOVING" | "WORKING" | "ERROR" | "OFFLINE";
type NodeType      = "WAYPOINT" | "STATION" | "CHARGER";
type EdgeDirection = "ONE_WAY" | "BOTH_WAY";
type TaskType      = "SUPPLY" | "PROCESS" | "DISTRIBUTE" | "CHARGE";
type TaskStatus    = "PENDING" | "ASSIGNED" | "RUNNING" | "COMPLETED" | "FAILED";

interface Robot {
  robot_id: string;
  ip: string;
  ros_domain_id: number;
  status: RobotStatus;
  location: string | null;
}

interface FleetMap {
  map_id: string;
  init_position: Record<string, { x: number; y: number; yaw: number }>;
}

interface FleetNode {
  node_id: string;
  map_id: string;
  type: NodeType;
  x: number;
  y: number;
  yaw: number;
}

interface FleetEdge {
  edge_id: string;
  map_id: string;
  startNode: string;
  endNode: string;
  direction: EdgeDirection;
  isLocked: boolean;
}

interface Task {
  _id: string;
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  targetNode: string;
  waitReason?: string;
  assignedRobot: { robot_id: string | null; is_completed: boolean };
  createdAt: string;
}

// ── API 헬퍼 ─────────────────────────────────────────────────────────────────

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── 공통 스타일 ───────────────────────────────────────────────────────────────

const TH = "px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-[#555] whitespace-nowrap";
const TD = "px-3 py-2 text-[11px] text-[#ccc] font-mono whitespace-nowrap";
const INP = "bg-[#111] border border-[#333] rounded px-2 py-1 text-[11px] text-[#ddd] font-mono w-full focus:outline-none focus:border-[#555]";
const SEL = `${INP} cursor-pointer`;
const BTN = (color: string) =>
  `px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border transition-colors ${color}`;

const STATUS_COLOR: Record<RobotStatus, string> = {
  IDLE:    "text-green-400",
  MOVING:  "text-blue-400",
  WORKING: "text-yellow-400",
  ERROR:   "text-red-400",
  OFFLINE: "text-[#555]",
};

const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  PENDING:   "text-yellow-500",
  ASSIGNED:  "text-blue-400",
  RUNNING:   "text-cyan-400",
  COMPLETED: "text-green-500",
  FAILED:    "text-red-500",
};

const TASK_TYPE_COLOR: Record<TaskType, string> = {
  SUPPLY:     "bg-blue-900/40 text-blue-300 border-blue-800/60",
  PROCESS:    "bg-yellow-900/40 text-yellow-300 border-yellow-800/60",
  DISTRIBUTE: "bg-purple-900/40 text-purple-300 border-purple-800/60",
  CHARGE:     "bg-green-900/40 text-green-300 border-green-800/60",
};

// ── 섹션: 로봇 ───────────────────────────────────────────────────────────────

function RobotSection({ liveStatuses }: { liveStatuses: Record<string, string> }) {
  const [robots, setRobots] = useState<Robot[]>([]);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Robot>>({});
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ robot_id: "", ip: "", ros_domain_id: 0 });
  const [err, setErr] = useState("");
  const [delConfirm, setDelConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRobots(await api<Robot[]>("/api/fleet/robots")); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editId) return;
    try {
      await api(`/api/fleet/robots/${editId}`, { method: "PATCH", body: JSON.stringify(editDraft) });
      setEditId(null);
      void load();
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

  return (
    <div>
      <SectionHeader title="로봇 등록부" count={robots.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} />
      {err && <ErrBar msg={err} onClose={() => setErr("")} />}
      <TableWrap>
        <thead>
          <tr className="border-b border-[#1e1e1e]">
            {["robot_id","ip","도메인 ID","상태","현재 위치",""].map(h => <th key={h} className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {adding && (
            <tr className="border-b border-[#1a1a1a] bg-[#0e1a0e]">
              <td className={TD}><input className={INP} placeholder="tb3_01" value={addDraft.robot_id} onChange={e => setAddDraft(d => ({ ...d, robot_id: e.target.value }))} /></td>
              <td className={TD}><input className={INP} placeholder="192.168.0.10" value={addDraft.ip} onChange={e => setAddDraft(d => ({ ...d, ip: e.target.value }))} /></td>
              <td className={TD}><input className={INP} type="number" value={addDraft.ros_domain_id} onChange={e => setAddDraft(d => ({ ...d, ros_domain_id: +e.target.value }))} /></td>
              <td className={TD} colSpan={2}><span className="text-[#444]">—</span></td>
              <td className={TD}>
                <div className="flex gap-1">
                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60 hover:bg-green-800/50")} onClick={add}>저장</button>
                  <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa]")} onClick={() => setAdding(false)}>취소</button>
                </div>
              </td>
            </tr>
          )}
          {robots.length === 0 && !adding && (
            <tr><td colSpan={6} className="px-3 py-6 text-center text-[#333] text-xs">등록된 로봇이 없습니다</td></tr>
          )}
          {robots.map(r => {
            const isEdit = editId === r.robot_id;
            return (
              <tr key={r.robot_id} className="border-b border-[#141414] hover:bg-[#0f0f0f] transition-colors">
                <td className={TD}>{r.robot_id}</td>
                <td className={TD}>
                  {isEdit
                    ? <input className={INP} value={editDraft.ip ?? r.ip} onChange={e => setEditDraft(d => ({ ...d, ip: e.target.value }))} />
                    : r.ip}
                </td>
                <td className={TD}>
                  {isEdit
                    ? <input className={INP} type="number" value={editDraft.ros_domain_id ?? r.ros_domain_id} onChange={e => setEditDraft(d => ({ ...d, ros_domain_id: +e.target.value }))} />
                    : r.ros_domain_id}
                </td>
                <td className={TD}>
                  {isEdit
                    ? <select className={SEL} value={editDraft.status ?? r.status} onChange={e => setEditDraft(d => ({ ...d, status: e.target.value as RobotStatus }))}>
                        {(["IDLE","MOVING","WORKING","ERROR","OFFLINE"] as RobotStatus[]).map(s => <option key={s}>{s}</option>)}
                      </select>
                    : (() => {
                        const live = liveStatuses[r.robot_id];
                        const display = (live ?? r.status) as RobotStatus;
                        const isLive  = live != null;
                        return (
                          <span className="inline-flex items-center gap-1.5">
                            {isLive && (
                              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                                display === "OFFLINE" ? "bg-[#555]" :
                                display === "IDLE"    ? "bg-green-400" :
                                display === "MOVING"  ? "bg-blue-400"  :
                                display === "WORKING" ? "bg-yellow-400": "bg-red-400"
                              }`} title="실시간" />
                            )}
                            <span className={`font-bold ${STATUS_COLOR[display]}`}>{display}</span>
                          </span>
                        );
                      })()}
                </td>
                <td className={TD}>{r.location ?? <span className="text-[#444]">—</span>}</td>
                <td className={TD}>
                  {delConfirm === r.robot_id ? (
                    <div className="flex gap-1 items-center">
                      <span className="text-red-400 text-[10px]">삭제?</span>
                      <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60 hover:bg-red-800/50")} onClick={() => del(r.robot_id)}>확인</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa]")} onClick={() => setDelConfirm(null)}>취소</button>
                    </div>
                  ) : isEdit ? (
                    <div className="flex gap-1">
                      <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60 hover:bg-green-800/50")} onClick={save}>저장</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa]")} onClick={() => setEditId(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <button className={BTN("bg-[#111] text-[#888] border-[#333] hover:text-[#ddd]")} onClick={() => { setEditId(r.robot_id); setEditDraft({ ip: r.ip, ros_domain_id: r.ros_domain_id, status: r.status }); setErr(""); }}>수정</button>
                      <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelConfirm(r.robot_id)}>삭제</button>
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

// ── 섹션: FleetMap ────────────────────────────────────────────────────────────

function MapSection() {
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
    try { setMaps(await api<FleetMap[]>("/api/fleet/maps")); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

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
          <tr className="border-b border-[#1e1e1e]">
            {["map_id","초기위치 로봇 수",""].map(h => <th key={h} className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {adding && (
            <tr className="border-b border-[#1a1a1a] bg-[#0e1a0e]">
              <td className={TD}><input className={INP} placeholder="floor_1" value={addMapId} onChange={e => setAddMapId(e.target.value)} /></td>
              <td className={TD}><span className="text-[#444]">—</span></td>
              <td className={TD}>
                <div className="flex gap-1">
                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60 hover:bg-green-800/50")} onClick={addMap}>저장</button>
                  <button className={BTN("bg-[#111] text-[#555] border-[#333] hover:text-[#aaa]")} onClick={() => setAdding(false)}>취소</button>
                </div>
              </td>
            </tr>
          )}
          {maps.length === 0 && !adding && (
            <tr><td colSpan={3} className="px-3 py-6 text-center text-[#333] text-xs">등록된 맵이 없습니다</td></tr>
          )}
          {maps.map(m => {
            const initCount = Object.keys(m.init_position ?? {}).length;
            const isExp = expanded === m.map_id;
            return (
              <Fragment key={m.map_id}>
                <tr key={m.map_id} className={`border-b border-[#141414] hover:bg-[#0f0f0f] transition-colors cursor-pointer ${isExp ? "bg-[#0f1410]" : ""}`}
                    onClick={() => setExpanded(isExp ? null : m.map_id)}>
                  <td className={TD}>
                    <span className="mr-1.5 text-[#444]">{isExp ? "▾" : "▸"}</span>
                    {m.map_id}
                  </td>
                  <td className={TD}><span className="text-[#888]">{initCount}개</span></td>
                  <td className={TD} onClick={e => e.stopPropagation()}>
                    {delConfirm === m.map_id ? (
                      <div className="flex gap-1 items-center">
                        <span className="text-red-400 text-[10px]">삭제?</span>
                        <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60")} onClick={() => del(m.map_id)}>확인</button>
                        <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setDelConfirm(null)}>취소</button>
                      </div>
                    ) : (
                      <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelConfirm(m.map_id)}>삭제</button>
                    )}
                  </td>
                </tr>
                {isExp && (
                  <tr key={`${m.map_id}-exp`} className="border-b border-[#141414] bg-[#080e08]">
                    <td colSpan={3} className="px-6 py-3">
                      <div className="text-[10px] text-[#555] uppercase tracking-widest mb-2">초기 위치 (init_position)</div>
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[#1a1a1a]">
                            {["robot_id","x","y","yaw",""].map(h => <th key={h} className={`${TH} text-[9px]`}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(m.init_position ?? {}).map(([rid, pos]) => {
                            const isEd = initEdit?.map_id === m.map_id && initEdit.robot_id === rid;
                            const initKey = `${m.map_id}::${rid}`;
                            return (
                              <tr key={rid} className="border-b border-[#111]">
                                <td className={`${TD} text-[10px]`}>{rid}</td>
                                {isEd ? (
                                  <>
                                    <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} value={initEdit.x} onChange={e => setInitEdit(d => d && ({ ...d, x: e.target.value }))} /></td>
                                    <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} value={initEdit.y} onChange={e => setInitEdit(d => d && ({ ...d, y: e.target.value }))} /></td>
                                    <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} value={initEdit.yaw} onChange={e => setInitEdit(d => d && ({ ...d, yaw: e.target.value }))} /></td>
                                    <td className={`${TD} text-[10px]`}>
                                      <div className="flex gap-1">
                                        <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={() => saveInitPos(m.map_id, rid, +initEdit.x, +initEdit.y, +initEdit.yaw)}>저장</button>
                                        <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setInitEdit(null)}>취소</button>
                                      </div>
                                    </td>
                                  </>
                                ) : delInitConfirm === initKey ? (
                                  <>
                                    <td className={`${TD} text-[10px]`}>{pos.x.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>{pos.y.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>{pos.yaw.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>
                                      <div className="flex gap-1 items-center">
                                        <span className="text-red-400">삭제?</span>
                                        <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60")} onClick={() => deleteInitPos(m.map_id, rid)}>확인</button>
                                        <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setDelInitConfirm(null)}>취소</button>
                                      </div>
                                    </td>
                                  </>
                                ) : (
                                  <>
                                    <td className={`${TD} text-[10px]`}>{pos.x.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>{pos.y.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>{pos.yaw.toFixed(3)}</td>
                                    <td className={`${TD} text-[10px]`}>
                                      <div className="flex gap-1">
                                        <button className={BTN("bg-[#111] text-[#888] border-[#333] hover:text-[#ddd]")} onClick={() => setInitEdit({ map_id: m.map_id, robot_id: rid, x: String(pos.x), y: String(pos.y), yaw: String(pos.yaw) })}>수정</button>
                                        <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelInitConfirm(initKey)}>삭제</button>
                                      </div>
                                    </td>
                                  </>
                                )}
                              </tr>
                            );
                          })}
                          {/* 추가 행 */}
                          {addInit?.map_id === m.map_id ? (
                            <tr className="border-b border-[#111] bg-[#0a1a0a]">
                              <td className={`${TD} text-[10px]`}><input className={`${INP} w-24`} placeholder="tb3_01" value={addInit.robot_id} onChange={e => setAddInit(d => d && ({ ...d, robot_id: e.target.value }))} /></td>
                              <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.x} onChange={e => setAddInit(d => d && ({ ...d, x: e.target.value }))} /></td>
                              <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.y} onChange={e => setAddInit(d => d && ({ ...d, y: e.target.value }))} /></td>
                              <td className={`${TD} text-[10px]`}><input className={`${INP} w-20`} placeholder="0.0" value={addInit.yaw} onChange={e => setAddInit(d => d && ({ ...d, yaw: e.target.value }))} /></td>
                              <td className={`${TD} text-[10px]`}>
                                <div className="flex gap-1">
                                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={() => saveInitPos(m.map_id, addInit.robot_id, +addInit.x, +addInit.y, +addInit.yaw)}>저장</button>
                                  <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setAddInit(null)}>취소</button>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            <tr>
                              <td colSpan={5} className="py-1.5 px-2">
                                <button className="text-[10px] text-[#444] hover:text-[#888] transition-colors" onClick={() => setAddInit({ map_id: m.map_id, robot_id: "", x: "0", y: "0", yaw: "0" })}>
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

// ── 섹션: Node ────────────────────────────────────────────────────────────────

function NodeSection() {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapFilter, setMapFilter] = useState("");
  const [maps, setMaps] = useState<string[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<FleetNode>>({});
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Partial<FleetNode>>({ type: "WAYPOINT", x: 0, y: 0, yaw: 0 });
  const [delConfirm, setDelConfirm] = useState<string | null>(null);
  const [err, setErr] = useState("");

  // 맵 목록 별도 fetch (노드가 없어도 선택 가능)
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
      // 노드에서 발견된 map_id도 목록에 추가
      setMaps(prev => [...new Set([...prev, ...all.map(n => n.map_id)])]);
    } catch {}
    setLoading(false);
  }, [mapFilter]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editId) return;
    try {
      await api(`/api/fleet/topology/nodes/${editId}`, { method: "PATCH", body: JSON.stringify(editDraft) });
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

  const displayed = mapFilter ? nodes.filter(n => n.map_id === mapFilter) : nodes;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <SectionHeader title="노드" count={displayed.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
        <select className={`${SEL} w-40`} value={mapFilter} onChange={e => setMapFilter(e.target.value)}>
          <option value="">전체 맵</option>
          {maps.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {err && <ErrBar msg={err} onClose={() => setErr("")} />}
      <TableWrap>
        <thead>
          <tr className="border-b border-[#1e1e1e]">
            {["node_id","map_id","타입","x","y","yaw",""].map(h => <th key={h} className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {adding && (
            <tr className="border-b border-[#1a1a1a] bg-[#0e1a0e]">
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
              <td className={TD}><input className={`${INP} w-20`} type="number" step="0.01" value={addDraft.yaw ?? 0} onChange={e => setAddDraft(d => ({ ...d, yaw: +e.target.value }))} /></td>
              <td className={TD}>
                <div className="flex gap-1">
                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={add}>저장</button>
                  <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setAdding(false)}>취소</button>
                </div>
              </td>
            </tr>
          )}
          {displayed.length === 0 && !adding && (
            <tr><td colSpan={7} className="px-3 py-6 text-center text-[#333] text-xs">노드 없음</td></tr>
          )}
          {displayed.map(n => {
            const isEdit = editId === n.node_id;
            const d = editDraft;
            return (
              <tr key={n.node_id} className="border-b border-[#141414] hover:bg-[#0f0f0f] transition-colors">
                <td className={TD}>{n.node_id}</td>
                <td className={TD}>{isEdit ? <input className={INP} value={d.map_id ?? n.map_id} onChange={e => setEditDraft(p => ({ ...p, map_id: e.target.value }))} /> : n.map_id}</td>
                <td className={TD}>{isEdit
                  ? <select className={SEL} value={d.type ?? n.type} onChange={e => setEditDraft(p => ({ ...p, type: e.target.value as NodeType }))}>{(["WAYPOINT","STATION","CHARGER"] as NodeType[]).map(t => <option key={t}>{t}</option>)}</select>
                  : <NodeTypeBadge type={n.type} />}
                </td>
                <td className={TD}>{isEdit ? <input className={`${INP} w-20`} type="number" step="0.01" value={d.x ?? n.x} onChange={e => setEditDraft(p => ({ ...p, x: +e.target.value }))} /> : n.x.toFixed(3)}</td>
                <td className={TD}>{isEdit ? <input className={`${INP} w-20`} type="number" step="0.01" value={d.y ?? n.y} onChange={e => setEditDraft(p => ({ ...p, y: +e.target.value }))} /> : n.y.toFixed(3)}</td>
                <td className={TD}>{isEdit ? <input className={`${INP} w-20`} type="number" step="0.01" value={d.yaw ?? n.yaw} onChange={e => setEditDraft(p => ({ ...p, yaw: +e.target.value }))} /> : n.yaw.toFixed(3)}</td>
                <td className={TD}>
                  {delConfirm === n.node_id ? (
                    <div className="flex gap-1 items-center">
                      <span className="text-red-400 text-[10px]">삭제?</span>
                      <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60")} onClick={() => del(n.node_id)}>확인</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setDelConfirm(null)}>취소</button>
                    </div>
                  ) : isEdit ? (
                    <div className="flex gap-1">
                      <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={save}>저장</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setEditId(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <button className={BTN("bg-[#111] text-[#888] border-[#333] hover:text-[#ddd]")} onClick={() => { setEditId(n.node_id); setEditDraft({ map_id: n.map_id, type: n.type, x: n.x, y: n.y, yaw: n.yaw }); setErr(""); }}>수정</button>
                      <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelConfirm(n.node_id)}>삭제</button>
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

// ── 섹션: Edge ────────────────────────────────────────────────────────────────

function EdgeSection() {
  const [edges, setEdges] = useState<FleetEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapFilter, setMapFilter] = useState("");
  const [maps, setMaps] = useState<string[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<FleetEdge>>({});
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Partial<FleetEdge>>({ direction: "BOTH_WAY", isLocked: false });
  const [delConfirm, setDelConfirm] = useState<string | null>(null);
  const [err, setErr] = useState("");

  // 맵 목록 별도 fetch
  useEffect(() => {
    api<FleetMap[]>("/api/fleet/maps")
      .then(ms => setMaps(ms.map(m => m.map_id)))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api<FleetEdge[]>("/api/fleet/topology/edges" + (mapFilter ? `?map_id=${mapFilter}` : ""));
      setEdges(all);
      setMaps(prev => [...new Set([...prev, ...all.map(e => e.map_id)])]);
    } catch {}
    setLoading(false);
  }, [mapFilter]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editId) return;
    try {
      await api(`/api/fleet/topology/edges/${editId}`, { method: "PATCH", body: JSON.stringify(editDraft) });
      setEditId(null); void load();
    } catch (e) { setErr(String(e)); }
  }

  async function add() {
    if (!addDraft.edge_id || !addDraft.map_id || !addDraft.startNode || !addDraft.endNode) {
      setErr("edge_id, map_id, startNode, endNode 필수"); return;
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
      await api(`/api/fleet/topology/edges/${edge.edge_id}/lock`, {
        method: "PATCH",
        body: JSON.stringify({ isLocked: !edge.isLocked }),
      });
      void load();
    } catch (e) { setErr(String(e)); }
  }

  const displayed = mapFilter ? edges.filter(e => e.map_id === mapFilter) : edges;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <SectionHeader title="엣지" count={displayed.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
        <select className={`${SEL} w-40`} value={mapFilter} onChange={e => setMapFilter(e.target.value)}>
          <option value="">전체 맵</option>
          {maps.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {err && <ErrBar msg={err} onClose={() => setErr("")} />}
      <TableWrap>
        <thead>
          <tr className="border-b border-[#1e1e1e]">
            {["edge_id","map_id","출발 → 도착","방향","잠금",""].map(h => <th key={h} className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {adding && (
            <tr className="border-b border-[#1a1a1a] bg-[#0e1a0e]">
              <td className={TD}><input className={INP} placeholder="E01" value={addDraft.edge_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, edge_id: e.target.value }))} /></td>
              <td className={TD}>
                <input className={INP} placeholder="floor_1" list="edge-maps-list" value={addDraft.map_id ?? ""} onChange={e => setAddDraft(d => ({ ...d, map_id: e.target.value }))} />
                <datalist id="edge-maps-list">{maps.map(m => <option key={m} value={m} />)}</datalist>
              </td>
              <td className={TD}>
                <div className="flex items-center gap-1">
                  <input className={`${INP} w-20`} placeholder="N01" value={addDraft.startNode ?? ""} onChange={e => setAddDraft(d => ({ ...d, startNode: e.target.value }))} />
                  <span className="text-[#444]">→</span>
                  <input className={`${INP} w-20`} placeholder="N02" value={addDraft.endNode ?? ""} onChange={e => setAddDraft(d => ({ ...d, endNode: e.target.value }))} />
                </div>
              </td>
              <td className={TD}>
                <select className={SEL} value={addDraft.direction} onChange={e => setAddDraft(d => ({ ...d, direction: e.target.value as EdgeDirection }))}>
                  <option value="BOTH_WAY">BOTH_WAY</option>
                  <option value="ONE_WAY">ONE_WAY</option>
                </select>
              </td>
              <td className={TD}><span className="text-[#444]">—</span></td>
              <td className={TD}>
                <div className="flex gap-1">
                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={add}>저장</button>
                  <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setAdding(false)}>취소</button>
                </div>
              </td>
            </tr>
          )}
          {displayed.length === 0 && !adding && (
            <tr><td colSpan={6} className="px-3 py-6 text-center text-[#333] text-xs">엣지 없음</td></tr>
          )}
          {displayed.map(e => {
            const isEdit = editId === e.edge_id;
            const d = editDraft;
            return (
              <tr key={e.edge_id} className="border-b border-[#141414] hover:bg-[#0f0f0f] transition-colors">
                <td className={TD}>{e.edge_id}</td>
                <td className={TD}>{isEdit ? <input className={INP} value={d.map_id ?? e.map_id} onChange={ev => setEditDraft(p => ({ ...p, map_id: ev.target.value }))} /> : e.map_id}</td>
                <td className={TD}>
                  {isEdit ? (
                    <div className="flex items-center gap-1">
                      <input className={`${INP} w-20`} value={d.startNode ?? e.startNode} onChange={ev => setEditDraft(p => ({ ...p, startNode: ev.target.value }))} />
                      <span className="text-[#444]">→</span>
                      <input className={`${INP} w-20`} value={d.endNode ?? e.endNode} onChange={ev => setEditDraft(p => ({ ...p, endNode: ev.target.value }))} />
                    </div>
                  ) : (
                    <span className="font-mono"><span className="text-[#aaa]">{e.startNode}</span><span className="text-[#444] mx-1">→</span><span className="text-[#aaa]">{e.endNode}</span></span>
                  )}
                </td>
                <td className={TD}>
                  {isEdit
                    ? <select className={SEL} value={d.direction ?? e.direction} onChange={ev => setEditDraft(p => ({ ...p, direction: ev.target.value as EdgeDirection }))}><option value="BOTH_WAY">BOTH_WAY</option><option value="ONE_WAY">ONE_WAY</option></select>
                    : <span className={e.direction === "BOTH_WAY" ? "text-cyan-500" : "text-yellow-600"}>{e.direction}</span>}
                </td>
                <td className={TD}>
                  <button
                    className={`px-2 py-0.5 text-[10px] font-bold rounded border transition-colors ${e.isLocked ? "bg-red-900/40 text-red-300 border-red-800/60 hover:bg-red-800/50" : "bg-[#111] text-[#555] border-[#333] hover:text-green-400"}`}
                    onClick={() => toggleLock(e)}
                  >{e.isLocked ? "잠김" : "열림"}</button>
                </td>
                <td className={TD}>
                  {delConfirm === e.edge_id ? (
                    <div className="flex gap-1 items-center">
                      <span className="text-red-400 text-[10px]">삭제?</span>
                      <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60")} onClick={() => del(e.edge_id)}>확인</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setDelConfirm(null)}>취소</button>
                    </div>
                  ) : isEdit ? (
                    <div className="flex gap-1">
                      <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={save}>저장</button>
                      <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setEditId(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <button className={BTN("bg-[#111] text-[#888] border-[#333] hover:text-[#ddd]")} onClick={() => { setEditId(e.edge_id); setEditDraft({ map_id: e.map_id, startNode: e.startNode, endNode: e.endNode, direction: e.direction }); setErr(""); }}>수정</button>
                      <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelConfirm(e.edge_id)}>삭제</button>
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

// ── 섹션: 태스크 ─────────────────────────────────────────────────────────────

function TaskSection() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ type: "SUPPLY" as TaskType, targetNode: "", priority: 5 });
  const [delConfirm, setDelConfirm] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api<Task[]>("/api/fms/tasks" + (statusFilter ? `?status=${statusFilter}` : "") + (!statusFilter ? "?limit=100" : "&limit=100")));
    } catch {}
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
    <div>
      <div className="flex items-center gap-3 mb-2">
        <SectionHeader title="태스크" count={tasks.length} onAdd={() => { setAdding(true); setErr(""); }} onRefresh={load} loading={loading} noMargin />
        <select className={`${SEL} w-40`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">전체 상태</option>
          {(["PENDING","ASSIGNED","RUNNING","COMPLETED","FAILED"] as TaskStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {err && <ErrBar msg={err} onClose={() => setErr("")} />}
      <TableWrap>
        <thead>
          <tr className="border-b border-[#1e1e1e]">
            {["task_id","타입","상태","우선순위","목표 노드","로봇","생성일",""].map(h => <th key={h} className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {adding && (
            <tr className="border-b border-[#1a1a1a] bg-[#0e1a0e]">
              <td className={TD}><span className="text-[#444] text-[10px]">자동 생성</span></td>
              <td className={TD}>
                <select className={SEL} value={addDraft.type} onChange={e => setAddDraft(d => ({ ...d, type: e.target.value as TaskType }))}>
                  {(["SUPPLY","PROCESS","DISTRIBUTE","CHARGE"] as TaskType[]).map(t => <option key={t}>{t}</option>)}
                </select>
              </td>
              <td className={TD}><span className="text-yellow-500 text-[10px]">PENDING</span></td>
              <td className={TD}>
                <input className={`${INP} w-16`} type="number" min={1} max={10} value={addDraft.priority} onChange={e => setAddDraft(d => ({ ...d, priority: +e.target.value }))} />
              </td>
              <td className={TD}>
                <input className={INP} placeholder="N01" value={addDraft.targetNode} onChange={e => setAddDraft(d => ({ ...d, targetNode: e.target.value }))} />
              </td>
              <td className={TD}><span className="text-[#444]">—</span></td>
              <td className={TD}><span className="text-[#444]">—</span></td>
              <td className={TD}>
                <div className="flex gap-1">
                  <button className={BTN("bg-green-900/40 text-green-300 border-green-800/60")} onClick={add}>생성</button>
                  <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setAdding(false)}>취소</button>
                </div>
              </td>
            </tr>
          )}
          {tasks.length === 0 && !adding && (
            <tr><td colSpan={8} className="px-3 py-6 text-center text-[#333] text-xs">태스크 없음</td></tr>
          )}
          {tasks.map(t => (
            <tr key={t._id} className="border-b border-[#141414] hover:bg-[#0f0f0f] transition-colors">
              <td className={`${TD} text-[10px] text-[#555]`}>{t.task_id.slice(0, 18)}</td>
              <td className={TD}><span className={`px-1.5 py-0.5 text-[9px] font-bold border rounded ${TASK_TYPE_COLOR[t.type]}`}>{t.type}</span></td>
              <td className={TD}><span className={`font-bold text-[10px] ${TASK_STATUS_COLOR[t.status]}`}>{t.status}</span></td>
              <td className={TD}><span className="text-[#888]">P{t.priority}</span></td>
              <td className={TD}>{t.targetNode}</td>
              <td className={TD}>{t.assignedRobot.robot_id ?? <span className="text-[#444]">—</span>}</td>
              <td className={`${TD} text-[#555] text-[10px]`}>{new Date(t.createdAt).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" })}</td>
              <td className={TD}>
                {delConfirm === t._id ? (
                  <div className="flex gap-1 items-center">
                    <span className="text-red-400 text-[10px]">영구삭제?</span>
                    <button className={BTN("bg-red-900/40 text-red-300 border-red-800/60")} onClick={() => deleteTask(t._id)}>확인</button>
                    <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setDelConfirm(null)}>취소</button>
                  </div>
                ) : cancelConfirm === t._id ? (
                  <div className="flex gap-1 items-center">
                    <span className="text-orange-400 text-[10px]">취소?</span>
                    <button className={BTN("bg-orange-900/40 text-orange-300 border-orange-800/60")} onClick={() => cancelTask(t._id)}>확인</button>
                    <button className={BTN("bg-[#111] text-[#555] border-[#333]")} onClick={() => setCancelConfirm(null)}>취소</button>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    {(t.status === "PENDING" || t.status === "ASSIGNED" || t.status === "RUNNING") && (
                      <button className={BTN("bg-[#111] text-orange-800 border-[#2a1a10] hover:text-orange-400")} onClick={() => setCancelConfirm(t._id)}>취소</button>
                    )}
                    <button className={BTN("bg-[#111] text-red-800 border-[#2a1010] hover:text-red-400")} onClick={() => setDelConfirm(t._id)}>삭제</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

// ── 공통 소형 컴포넌트 ────────────────────────────────────────────────────────

function SectionHeader({ title, count, onAdd, onRefresh, loading, noMargin }: {
  title: string; count: number; onAdd: () => void; onRefresh: () => void; loading: boolean; noMargin?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${noMargin ? "" : "mb-2"}`}>
      <h2 className="text-[11px] font-bold text-[#888] uppercase tracking-widest">{title}</h2>
      <span className="text-[10px] text-[#444] font-mono">{count}건</span>
      <div className="flex-1" />
      <button
        className={BTN("bg-[#111] text-[#666] border-[#333] hover:text-[#bbb]") + " text-[10px]"}
        onClick={onRefresh}
        disabled={loading}
      >{loading ? "..." : "새로고침"}</button>
      <button
        className={BTN("bg-blue-950/60 text-blue-400 border-blue-900/60 hover:bg-blue-900/50")}
        onClick={onAdd}
      >+ 추가</button>
    </div>
  );
}

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-[#1a1a1a]">
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

function ErrBar({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="mb-2 px-3 py-2 bg-red-950/40 border border-red-900/50 rounded text-[10px] text-red-400 font-mono flex justify-between">
      {msg}
      <button className="text-[#555] hover:text-[#aaa] ml-4" onClick={onClose}>✕</button>
    </div>
  );
}

function NodeTypeBadge({ type }: { type: NodeType }) {
  const c = type === "WAYPOINT" ? "text-blue-400" : type === "STATION" ? "text-yellow-400" : "text-green-400";
  return <span className={`font-bold text-[10px] ${c}`}>{type}</span>;
}

// ── 메인 AdminView ────────────────────────────────────────────────────────────

type AdminTab = "editor" | "robots" | "maps" | "nodes" | "edges" | "tasks";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "editor", label: "⊞ 토폴로지 편집기" },
  { id: "robots", label: "로봇" },
  { id: "maps",   label: "맵 (FleetMap)" },
  { id: "nodes",  label: "노드" },
  { id: "edges",  label: "엣지" },
  { id: "tasks",  label: "태스크" },
];

export default function AdminView() {
  const [tab, setTab] = useState<AdminTab>("editor");
  const { robotStatuses } = useNestSocket();

  return (
    <div className="h-full flex flex-col bg-[#050505] text-[#d4d4d4] overflow-hidden">
      {/* 탭 바 */}
      <div className="flex-none flex border-b border-[#1a1a1a] bg-[#080808] px-4 pt-2 gap-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
              tab === t.id
                ? "border-indigo-500 text-indigo-300"
                : "border-transparent text-[#444] hover:text-[#888]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 컨텐츠 */}
      {tab === "editor" ? (
        <div className="flex-1 overflow-hidden">
          <TopologyEditor />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "robots" && <RobotSection liveStatuses={robotStatuses} />}
          {tab === "maps"   && <MapSection />}
          {tab === "nodes"  && <NodeSection />}
          {tab === "edges"  && <EdgeSection />}
          {tab === "tasks"  && <TaskSection />}
        </div>
      )}
    </div>
  );
}
