import { useState, useMemo, useEffect } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskManagerAlert } from "../hooks/useNestSocket";
import NavMapCanvas from "../components/NavMapCanvas";
import { type RobotPos } from "../components/TopologyMapView";
import { BACKEND_URL } from "../config";

const ROBOTS = [
 { id: "vicpinky", label: "VIC-PINKY", domain: 40, type: "carrier" },
 { id: "tb3_01", label: "UNIT-ALPHA", domain: 41, type: "tb3" },
 { id: "tb3_02", label: "UNIT-BRAVO", domain: 42, type: "tb3" },
 { id: "tb3_03", label: "UNIT-CHARLIE", domain: 43, type: "tb3" },
 { id: "tb3_04", label: "UNIT-DELTA", domain: 44, type: "tb3" },
 { id: "omx", label: "OMX-ARM", domain: 45, type: "arm" },
] as const;

const TASK_LABELS: Record<TaskType, string> = {
 SUPPLY: "SUPPLY", PROCESS: "PROCESS", CHARGE: "CHARGE", MOVE: "MOVE"
};

const ONLINE_THRESHOLD_MS = 5000;

interface Props {
 rosMessages: Record<string, RosMessage>;
 fmsTasks: FmsTask[];
 tmAlerts: TaskManagerAlert[];
 socket: Socket | null;
 emitFmsDispatch: (p: FmsDispatchPayload) => void;
 emitFmsCancel: (taskId: string) => void;
 emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 ackTmAlert: (alertId: string) => void;
 setRobotHome: (robotId: string, x: number, y: number, yaw: number) => void;
 lockedNodes?: Set<string>;
}

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
 const topics = robotId === "vicpinky" ? ["/vicpinky/odom"] : robotId === "omx" ? ["/omx/joint_states"] : [`/${robotId}/odom`];
 const now = Date.now();
 return topics.some(t => rosMessages[t] && now - rosMessages[t].timestamp < ONLINE_THRESHOLD_MS);
}

export default function FmsView({
 rosMessages, fmsTasks, tmAlerts, socket,
 emitFmsDispatch, emitFmsCancel,
 emitNavInitialPose,
 ackTmAlert, setRobotHome,
 lockedNodes = new Set(),
}: Props) {
 const [filterTab, setFilterTab] = useState<string>("all");
 const [contentTab, setContentTab] = useState<"fleet" | "map">("map");
 const [mapAssignments, setMapAssignments] = useState<Record<string, string>>({});
 const [form, setForm] = useState({ type: "SUPPLY" as TaskType, targetNode: "", priority: 5, preferredRobotId: "" });

 // rosMessages가 안 바뀌어도 isOnline() 재계산을 위해 주기적 리렌더
 const [, setTick] = useState(0);
 useEffect(() => {
  const id = setInterval(() => setTick(t => t + 1), 2000);
  return () => clearInterval(id);
 }, []);

 useEffect(() => {
 fetch(`${BACKEND_URL}/api/map/assignments`).then(r => r.json()).then(d => setMapAssignments(d)).catch(() => {});
 }, []);

 const onlineCount = ROBOTS.filter(r => isOnline(rosMessages, r.id)).length;
 const activeCount = fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status)).length;

 const filtered = useMemo(() => {
 if (filterTab === "all") return fmsTasks;
 if (filterTab === "active") return fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status));
 return fmsTasks.filter(t => t.status === filterTab);
 }, [fmsTasks, filterTab]);

 const activePaths = useMemo(() => fmsTasks.filter(t => (t.status === "RUNNING" || t.status === "ASSIGNED") && t.assignedRobot?.robot_id && t.pathQueue?.length).map(t => ({ robotId: t.assignedRobot.robot_id!, pathQueue: t.pathQueue ?? [] })), [fmsTasks]);

 const robotPositions = useMemo(() => {
 const result: Record<string, RobotPos> = {};
 ROBOTS.forEach(r => {
  // AMCL 우선 (맵 프레임 — 좌표계 일치)
  const amcl = rosMessages[`/${r.id}/amcl_pose`]?.data as any;
  const amclPos = amcl?.pose?.pose?.position;
  if (amclPos?.x != null) { result[r.id] = { x: amclPos.x, y: amclPos.y }; return; }
  // odom 폴백 (odom 프레임 — 근사치, TF 없이도 동작)
  const odom = rosMessages[`/${r.id}/odom`]?.data as any;
  const odomPos = odom?.pose?.pose?.position;
  if (odomPos?.x != null) result[r.id] = { x: odomPos.x, y: odomPos.y };
 });
 return result;
 }, [rosMessages]);

 return (
 <div className="flex flex-col h-full bg-transparent overflow-hidden">
 
 {/* ── Status Bar ────────────────────────────────────────────────── */}
 <div className="flex-none flex items-center justify-between px-8 py-4 bg-white/[0.02] backdrop-blur-3xl border-b border-white/[0.05]">
 <div className="flex items-center gap-10">
 <Stat label="Fleet Active" value={`${onlineCount}/${ROBOTS.length}`} color="text-white/90" />
 <Stat label="Tasks Running" value={String(activeCount)} color="text-white/90" />
 {tmAlerts.length > 0 && <Stat label="Pending Alerts" value={String(tmAlerts.length)} color="text-white/90 " />}
 </div>
 <div className="flex bg-white/5 p-1 rounded-xl border border-white/[0.05]">
 <button onClick={() => setContentTab("map")} className={`px-5 py-1.5 text-xs font-semibold tracking-wide rounded-lg transition-all ${contentTab === 'map' ? 'bg-white/10 text-white shadow-lg' : 'text-white/20 hover:text-white/40'}`}>TOPOLOGY</button>
 <button onClick={() => setContentTab("fleet")} className={`px-5 py-1.5 text-xs font-semibold tracking-wide rounded-lg transition-all ${contentTab === 'fleet' ? 'bg-white/10 text-white shadow-lg' : 'text-white/20 hover:text-white/40'}`}>ASSET LIST</button>
 </div>
 </div>

 <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
 
 {/* ── Main View Area ───────────────────────────────────────────── */}
 <div className="flex-1 flex flex-col overflow-hidden bg-black/10">
 {contentTab === "map" ? (
 <NavMapCanvas
 rosMessages={rosMessages} socket={socket} onSetInitialPose={emitNavInitialPose} onSetHome={setRobotHome}
 activePaths={activePaths} robotPositions={robotPositions} lockedNodes={lockedNodes}
 onNodeClick={n => setForm(f => ({ ...f, targetNode: n }))}
 />
 ) : (
 <div className="p-8 overflow-y-auto">
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
 {ROBOTS.map(r => (
 <RobotStatusCard key={r.id} robot={r} rosMessages={rosMessages} fmsTasks={fmsTasks} mapAssignment={mapAssignments[r.id]} />
 ))}
 </div>
 </div>
 )}
 </div>

 {/* ── Task Panel ───────────────────────────────────────────────── */}
 <aside className="w-full md:w-80 flex-none flex flex-col bg-white/[0.02] backdrop-blur-3xl border-l border-white/[0.05]">
 <div className="flex-none p-6 border-b border-white/[0.05]">
 <span className="sub-label">Operations Control</span>
 <h2 className="text-lg font-semibold text-white/90 tracking-wide mt-1">DISPATCH</h2>
 </div>

 <div className="flex-1 overflow-y-auto">
 <div className="flex bg-white/5 mx-6 mt-4 p-1 rounded-lg border border-white/[0.05]">
 {['all', 'active'].map(t => (
 <button key={t} onClick={() => setFilterTab(t)} className={`flex-1 py-1 text-xs font-semibold tracking-wide rounded transition-all ${filterTab === t ? 'bg-white/10 text-white shadow-md' : 'text-white/20 hover:text-white/40'}`}>{t}</button>
 ))}
 </div>
 <div className="p-4 space-y-2">
 {filtered.map(t => <TaskItem key={t._id} task={t} onCancel={() => emitFmsCancel(t._id)} />)}
 </div>
 </div>

 {/* Create Task Form */}
 <div className="flex-none p-4 bg-white/[0.02] border-t border-white/[0.05]">
 <div className="space-y-3">
 <div>
 <span className="sub-label">Task Type</span>
 <div className="grid grid-cols-3 gap-1 mt-1">
 {(Object.keys(TASK_LABELS) as TaskType[]).map(t => (
 <button
 key={t}
 onClick={() => setForm(f => ({ ...f, type: t }))}
 className={`py-1 text-[10px] font-bold tracking-wide rounded border transition-all ${form.type === t ? 'bg-sky-600/40 text-sky-200 border-sky-500/60' : 'bg-black/30 text-white/30 border-white/[0.05] hover:text-white/60'}`}
 >
 {TASK_LABELS[t]}
 </button>
 ))}
 </div>
 </div>
 <div>
 <span className="sub-label">Destination Node</span>
 <input value={form.targetNode} onChange={e => setForm(f => ({ ...f, targetNode: e.target.value }))} className="w-full bg-black/40 border border-white/[0.05] rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/10 focus:outline-none focus:border-white/[0.05]" placeholder="e.g. 401_7" />
 </div>
 <div>
 <span className="sub-label">Preferred Asset</span>
 <select value={form.preferredRobotId} onChange={e => setForm(f => ({ ...f, preferredRobotId: e.target.value }))} className="w-full bg-black/40 border border-white/[0.05] rounded-xl px-3 py-2 text-sm text-white appearance-none focus:outline-none focus:border-white/[0.05]">
 <option value="">AUTO ASSIGNMENT</option>
 {ROBOTS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
 </select>
 </div>
 <button onClick={() => { if(form.targetNode) emitFmsDispatch(form); setForm(f => ({ ...f, targetNode: "" })) }} className="w-full glass-button !bg-sky-600 hover:!bg-sky-500 !text-xs !font-semibold !tracking-wide !py-2.5 !rounded-xl shadow-xl">AUTHORIZE DISPATCH</button>
 </div>
 </div>
 </aside>
 </div>
 </div>
 );
}

function Stat({ label, value, color }: any) {
 return (
 <div className="flex flex-col items-center">
 <span className="text-xs text-white/20 font-semibold tracking-wide mb-1">{label}</span>
 <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
 </div>
 );
}

function RobotStatusCard({ robot, rosMessages, fmsTasks, mapAssignment }: any) {
 const online = isOnline(rosMessages, robot.id);
 const task = fmsTasks.find((t: any) => t.assignedRobot?.robot_id === robot.id && ["ASSIGNED", "RUNNING"].includes(t.status));
 const bat = (rosMessages[`/${robot.id}/battery_state`]?.data as any)?.percentage;
 const batPct = bat != null ? Math.round(bat > 1 ? bat : bat * 100) : null;

 return (
 <div className={`glass-card p-5 transition-all duration-700 ${online ? 'opacity-100 scale-100 shadow-xl' : 'opacity-40 scale-[0.98]'}`}>
 <div className="flex justify-between items-start mb-4">
 <div>
 <h3 className="text-sm font-semibold text-white/90 tracking-wide">{robot.label}</h3>
 <span className="text-xs text-white/20 tracking-wide">DOMAIN {robot.domain}</span>
 </div>
 <div className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500 ' : 'bg-white/5'}`} />
 </div>
 
 {online ? (
 <div className="space-y-4">
 {batPct !== null && (
 <div className="space-y-1.5">
 <div className="flex justify-between text-xs font-semibold tracking-wide">
 <span className="text-white/20">POWER RESERVE</span>
 <span className={batPct < 20 ? "text-white/90" : "text-white/90"}>{batPct}%</span>
 </div>
 <div className="h-1 bg-white/5 rounded-full overflow-hidden">
 <div className={`h-full rounded-full transition-all duration-1000 ${batPct < 20 ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${batPct}%` }} />
 </div>
 </div>
 )}
 {task ? (
 <div className="p-3 bg-white/[0.03] border border-white/[0.05] rounded-xl">
 <span className="sub-label !text-xs !mb-1">Active Mission</span>
 <div className="flex justify-between items-center">
 <span className="text-xs font-bold text-white/90 ">{TASK_LABELS[task.type as TaskType]}</span>
 <span className="text-xs text-white/40 ">→ {task.targetNode}</span>
 </div>
 </div>
 ) : (
 <div className="text-center py-2 border border-dashed border-white/[0.05] rounded-xl">
 <span className="text-xs font-semibold text-white/10 tracking-wide ">Standby Mode</span>
 </div>
 )}
 </div>
 ) : (
 <div className="py-8 text-center">
 <span className="text-xs text-white/10 italic">Signal Lost...</span>
 </div>
 )}
 </div>
 );
}

function TaskItem({ task, onCancel }: any) {
 return (
 <div className="glass-card !bg-white/[0.02] border-white/[0.05] p-4 hover:border-white/[0.05] transition-colors group">
 <div className="flex justify-between items-start mb-2">
 <div className="flex items-center gap-2">
 <div className={`w-1.5 h-1.5 rounded-full ${task.status === 'RUNNING' ? 'bg-sky-400 animate-pulse' : 'bg-amber-400'}`} />
 <span className="text-xs font-semibold text-white/80 ">{TASK_LABELS[task.type as TaskType]}</span>
 </div>
 <button onClick={onCancel} className="text-white/10 hover:text-white/90 transition-colors text-sm leading-none opacity-0 group-hover:opacity-100">✕</button>
 </div>
 <div className="flex justify-between items-end">
 <div className="text-xs text-white/30 tracking-wide">Target: {task.targetNode}</div>
 <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${task.status === 'RUNNING' ? 'text-white/90 border-white/[0.05] bg-sky-500/5' : 'text-white/90 border-white/[0.05] bg-amber-500/5'}`}>{task.status}</span>
 </div>
 </div>
 );
}
