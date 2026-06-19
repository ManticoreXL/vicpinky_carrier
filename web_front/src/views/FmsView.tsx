import { useState, useMemo, useEffect } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskManagerAlert, RobotInfo } from "../hooks/useNestSocket";
import NavMapCanvas from "../components/NavMapCanvas";
import { type RobotPos } from "../components/TopologyMapView";
import { BACKEND_URL } from "../config";
import { taskTypeKo, taskStatusKo } from "../utils/statusLabel";

const ROBOTS = [
 { id: "vicpinky", domain: 40, type: "carrier" },
 { id: "tb3_01",   domain: 41, type: "tb3" },
 { id: "tb3_02",   domain: 42, type: "tb3" },
 { id: "tb3_03",   domain: 43, type: "tb3" },
 { id: "tb3_04",   domain: 44, type: "tb3" },
 { id: "omx",      domain: 45, type: "arm" },
 // rosbridge 미경유 가상 테스트봇 4대 (항상 성공)
 { id: "TEST-BOT1", domain: 99,  type: "test" },
 { id: "TEST-BOT2", domain: 100, type: "test" },
 { id: "TEST-BOT3", domain: 101, type: "test" },
 { id: "TEST-BOT4", domain: 102, type: "test" },
] as const;

const TASK_LABELS: Record<TaskType, string> = {
 SUPPLY: "공급", PROCESS: "구호", CHARGE: "충전", MOVE: "이동"
};

// 공급(SUPPLY)은 omx(로봇팔) 전용 — 목적지 노드 대신 보급 품목을 선택
const SUPPLY_ROBOT_ID = "omx";
const SUPPLY_ITEMS = ["물", "약"] as const;
type SupplyItem = typeof SUPPLY_ITEMS[number];

const ONLINE_THRESHOLD_MS = 5000;

interface TopoNode { node_id: string; x: number; y: number; type: string; }

interface Props {
 rosMessages: Record<string, RosMessage>;
 fmsTasks: FmsTask[];
 tmAlerts: TaskManagerAlert[];
 socket: Socket | null;
 emitFmsDispatch: (p: FmsDispatchPayload) => void;
 emitFmsCancel: (taskId: string) => void;
 emitFmsRegister: (p: FmsDispatchPayload) => void;
 emitFmsRelease: (taskId: string) => void;
 emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 ackTmAlert: (alertId: string) => void;
 setRobotHome: (robotId: string, x: number, y: number, yaw: number) => void;
 lockedNodes?: Set<string>;
 focusRobotId?: string;
 robots?: RobotInfo[];
 robotStatuses?: Record<string, string>;
}

// ── 추천 로봇 점수 산정 ────────────────────────────────────────────────────────
// 우선순위 = (대기 가용성) > (배터리) > (목적지 근접도). 사람이 최종 할당.
interface RobotScore {
 robotId: string;
 online: boolean;
 busy: boolean;
 status: string;
 batPct: number | null;
 dist: number | null;   // 목적지 노드까지 거리(m)
 score: number;
 reason: string;
}

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
 const topics = robotId === "vicpinky" ? ["/vicpinky/odom"] : robotId === "omx" ? ["/omx/joint_states"] : [`/${robotId}/odom`];
 const now = Date.now();
 return topics.some(t => rosMessages[t] && now - rosMessages[t].timestamp < ONLINE_THRESHOLD_MS);
}

export default function FmsView({
 rosMessages, fmsTasks, tmAlerts, socket,
 emitFmsDispatch, emitFmsCancel, emitFmsRegister, emitFmsRelease,
 emitNavInitialPose,
 ackTmAlert, setRobotHome,
 lockedNodes = new Set(),
 focusRobotId,
 robots = [],
 robotStatuses = {},
}: Props) {
 const [filterTab, setFilterTab] = useState<string>("all");
 const [contentTab, setContentTab] = useState<"fleet" | "map">("map");
 const [mapAssignments, setMapAssignments] = useState<Record<string, string>>({});
 const [topoNodes, setTopoNodes] = useState<TopoNode[]>([]);
 const [form, setForm] = useState({ type: "SUPPLY" as TaskType, targetNode: "", priority: 5, preferredRobotId: focusRobotId ?? "", supplyItem: "물" as SupplyItem });

 const isSupply = form.type === "SUPPLY";

 // TaskManager에서 로봇 선택 시 dispatch form 동기화 (공급은 omx 고정이라 무시)
 useEffect(() => {
  if (focusRobotId && !isSupply) setForm(f => ({ ...f, preferredRobotId: focusRobotId }));
 }, [focusRobotId, isSupply]);

 // 공급(SUPPLY)은 omx 전용 — 선택 시 지정 로봇을 omx로 고정
 useEffect(() => {
  if (isSupply) setForm(f => (f.preferredRobotId === SUPPLY_ROBOT_ID ? f : { ...f, preferredRobotId: SUPPLY_ROBOT_ID }));
 }, [isSupply]);

 // 목적지가 충전소로 바뀌면 태스크 유형을 CHARGE로 자동 인식 (이후 수동 변경은 허용)
 useEffect(() => {
  const node = topoNodes.find(n => n.node_id === form.targetNode);
  if (node?.type === "CHARGER") {
   setForm(f => f.type === "CHARGE" ? f : { ...f, type: "CHARGE" });
  }
 }, [form.targetNode, topoNodes]);

 // rosMessages가 안 바뀌어도 isOnline() 재계산을 위해 주기적 리렌더
 const [, setTick] = useState(0);
 useEffect(() => {
  const id = setInterval(() => setTick(t => t + 1), 2000);
  return () => clearInterval(id);
 }, []);

 useEffect(() => {
 fetch(`${BACKEND_URL}/api/map/assignments`).then(r => r.json()).then((d: Record<string, string>) => {
  setMapAssignments(d);
  const mapId = Object.values(d)[0];
  if (mapId) {
   fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${mapId}`)
    .then(r => r.json()).then(setTopoNodes).catch(() => {});
  }
 }).catch(() => {});
 }, []);

 const onlineCount = ROBOTS.filter(r => isOnline(rosMessages, r.id)).length;
 const activeCount = fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status)).length;

 const filtered = useMemo(() => {
 if (filterTab === "all") return fmsTasks;
 if (filterTab === "active") return fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status));
 return fmsTasks.filter(t => t.status === filterTab);
 }, [fmsTasks, filterTab]);

 // 충전소 노드 id 집합 (목적지가 충전소면 CHARGE로 인식 + 경로 색 구분)
 const chargerNodeIds = useMemo(
  () => new Set(topoNodes.filter(n => n.type === "CHARGER").map(n => n.node_id)),
  [topoNodes],
 );

 const activePaths = useMemo(() =>
  fmsTasks
   .filter(t => (t.status === "RUNNING" || t.status === "ASSIGNED") && t.assignedRobotId && t.pathQueue?.length)
   .map(t => {
    // 태스크 타입이 CHARGE거나, 목적지 노드가 충전소면 충전 경로로 표시
    const dest = t.targetNode ?? (t.pathQueue ?? [])[(t.pathQueue?.length ?? 1) - 1];
    const isCharge = t.type === "CHARGE" || chargerNodeIds.has(dest);
    return {
     robotId: t.assignedRobotId!,
     pathQueue: t.pathQueue ?? [],
     fullPath: t.fullPath,
     taskType: isCharge ? "CHARGE" : t.type,
    };
   }),
 [fmsTasks, chargerNodeIds]);

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

 // ── 추천 로봇 순위 산정 ──────────────────────────────────────────────────────
 // 점수 = 가용성(대기/비번) 50 + 배터리 0~30 + 목적지 근접 0~20. 오프라인은 제외.
 const recommendations = useMemo<RobotScore[]>(() => {
  const targetNode = topoNodes.find(n => n.node_id === form.targetNode);
  const busyIds = new Set(
   fmsTasks.filter(t => ["ASSIGNED", "RUNNING"].includes(t.status) && t.assignedRobotId)
           .map(t => t.assignedRobotId as string),
  );

  const scored = ROBOTS.map<RobotScore>(r => {
   const online = isOnline(rosMessages, r.id);
   const dbInfo = robots.find(ri => ri.robot_id === r.id);
   const status = (robotStatuses[r.id] ?? dbInfo?.status ?? "IDLE");
   const busy   = busyIds.has(r.id) || status === "MOVING" || status === "WORKING";

   const batRos = (rosMessages[`/${r.id}/battery_state`]?.data as any)?.percentage;
   const batRaw = batRos ?? dbInfo?.battery ?? null;
   const batPct = batRaw != null ? Math.round(batRaw > 1 ? batRaw : batRaw * 100) : null;

   const pos = robotPositions[r.id];
   const dist = (targetNode && pos) ? Math.hypot(pos.x - targetNode.x, pos.y - targetNode.y) : null;

   let score = 0;
   const reasons: string[] = [];
   if (!online) {
    return { robotId: r.id, online, busy, status, batPct, dist, score: -1, reason: "오프라인" };
   }
   if (status === "ERROR") {
    return { robotId: r.id, online, busy, status, batPct, dist, score: -1, reason: "오류 상태" };
   }
   if (!busy && status === "IDLE") { score += 50; reasons.push("대기 중"); }
   else { reasons.push("작업 중"); }

   if (batPct != null) {
    score += Math.min(30, batPct * 0.3);
    if (batPct < 20) reasons.push("배터리 부족");
   }
   if (dist != null) {
    score += Math.max(0, 20 - dist * 2); // 가까울수록 가산 (10m 이상이면 0)
    reasons.push(`${dist.toFixed(1)}m`);
   }
   return { robotId: r.id, online, busy, status, batPct, dist, score, reason: reasons.join(" · ") };
  });

  return scored.sort((a, b) => b.score - a.score);
 }, [topoNodes, form.targetNode, fmsTasks, rosMessages, robots, robotStatuses, robotPositions]);

 const topPick = recommendations.find(r => r.score >= 0) ?? null;

 // 특정 로봇을 지정했는데 오프라인이면 등록/할당 불가 (자동 배정은 항상 허용)
 // 공급은 omx 고정이므로 omx 온라인 여부로 판단.
 const preferredId = isSupply ? SUPPLY_ROBOT_ID : form.preferredRobotId;
 const preferredOffline = preferredId !== "" && !isOnline(rosMessages, preferredId);
 const hasTarget = isSupply ? !!form.supplyItem : !!form.targetNode;
 const canSubmit = hasTarget && !preferredOffline;

 // 전송 페이로드 — 공급은 목적지 노드 대신 품목(물/약)을 targetNode로 전달, omx 고정
 const buildPayload = (): FmsDispatchPayload => isSupply
  ? { type: "SUPPLY", targetNode: form.supplyItem, priority: form.priority, preferredRobotId: SUPPLY_ROBOT_ID }
  : { type: form.type, targetNode: form.targetNode, priority: form.priority, preferredRobotId: form.preferredRobotId || undefined };

 const submit = (emit: (p: FmsDispatchPayload) => void) => {
  if (!canSubmit) return;
  emit(buildPayload());
  setForm(f => ({ ...f, targetNode: "" }));
 };

 return (
 <div className="flex flex-col h-full bg-transparent overflow-hidden">
 
 {/* ── Status Bar ────────────────────────────────────────────────── */}
 <div className="flex-none flex items-center justify-between px-8 py-4 bg-[#FFCE99]/32 backdrop-blur-3xl border-b border-white/[0.1]">
 <div className="flex items-center gap-10">
 <Stat label="운용 중" value={`${onlineCount}/${ROBOTS.length}`} color="text-white/90" />
 <Stat label="진행 태스크" value={String(activeCount)} color="text-white/90" />
 {tmAlerts.length > 0 && <Stat label="알림" value={String(tmAlerts.length)} color="text-white/90 " />}
 </div>
 <div className="flex items-center gap-3">
  {/* 집중 로봇 드롭다운 */}
  <div className="flex items-center gap-2">
   <span className="text-[9px] text-white/[0.45] font-bold tracking-widest uppercase">집중</span>
   <select
    value={form.preferredRobotId}
    onChange={e => setForm(f => ({ ...f, preferredRobotId: e.target.value }))}
    className="bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1 text-xs text-white/[0.75] appearance-none focus:outline-none focus:border-white/[0.08]"
   >
    <option value="">전체 로봇</option>
    {ROBOTS.map(r => {
     const online = isOnline(rosMessages, r.id);
     return <option key={r.id} value={r.id} disabled={!online}>{r.id}{online ? "" : " (오프라인)"}</option>;
    })}
   </select>
  </div>
  <div className="bg-[#FFCE99]/32 p-1 rounded-xl border border-white/[0.1] flex">
   <button onClick={() => setContentTab("map")} className={`px-5 py-1.5 text-xs font-semibold tracking-wide rounded-lg transition-all ${contentTab === 'map' ? 'bg-white/10 text-white shadow-lg' : 'text-white/[0.45] hover:text-white/[0.6]'}`}>지도</button>
   <button onClick={() => setContentTab("fleet")} className={`px-5 py-1.5 text-xs font-semibold tracking-wide rounded-lg transition-all ${contentTab === 'fleet' ? 'bg-white/10 text-white shadow-lg' : 'text-white/[0.45] hover:text-white/[0.6]'}`}>로봇 목록</button>
  </div>
 </div>
 </div>

 <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
 
 {/* ── Main View Area ───────────────────────────────────────────── */}
 <div className="flex-1 flex flex-col overflow-hidden bg-[#FFCE99]/32">
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
 <aside className="w-full md:w-80 flex-none flex flex-col bg-[#FFCE99]/32 backdrop-blur-3xl border-l border-white/[0.1]">
 <div className="flex-none p-6 border-b border-white/[0.1]">
 <span className="sub-label">운영 제어</span>
 <h2 className="text-lg font-semibold text-white/90 tracking-wide mt-1">명령 할당</h2>
 </div>

 <div className="flex-1 overflow-y-auto">
 <div className="flex bg-[#FFCE99]/32 mx-6 mt-4 p-1 rounded-lg border border-white/[0.1]">
 {([['all', '전체'], ['active', '진행 중'], ['DRAFT', '등록됨']] as [string, string][]).map(([val, label]) => (
 <button key={val} onClick={() => setFilterTab(val)} className={`flex-1 py-1 text-xs font-semibold tracking-wide rounded transition-all ${filterTab === val ? 'bg-white/10 text-white shadow-md' : 'text-white/[0.45] hover:text-white/[0.6]'}`}>{label}</button>
 ))}
 </div>
 <div className="p-4 space-y-2">
 {filtered.length === 0
  ? <p className="text-center text-xs text-white/[0.4] py-6">표시할 태스크가 없습니다</p>
  : filtered.map(t => <TaskItem key={t._id} task={t} onCancel={() => emitFmsCancel(t._id)} onRelease={() => emitFmsRelease(t._id)} />)}
 </div>
 </div>

 {/* 태스크 생성 폼 */}
 <div className="flex-none p-4 bg-[#FFCE99]/32 border-t border-white/[0.1]">
 <div className="space-y-3">
 <div>
 <span className="sub-label">태스크 유형</span>
 <div className="grid grid-cols-4 gap-1 mt-1">
 {(Object.keys(TASK_LABELS) as TaskType[]).map(t => (
 <button
 key={t}
 onClick={() => setForm(f => ({ ...f, type: t }))}
 className={`py-1 text-[10px] font-bold tracking-wide rounded border transition-all ${form.type === t ? 'bg-sky-600/40 text-sky-800 border-sky-500/60' : 'bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1] hover:text-white/[0.75]'}`}
 >
 {TASK_LABELS[t]}
 </button>
 ))}
 </div>
 </div>
 {isSupply ? (
 <div>
 <span className="sub-label">보급 품목 <span className="text-white/[0.4] normal-case">(omx 전용 · 하나 선택)</span></span>
 <div className="grid grid-cols-2 gap-1 mt-1">
 {SUPPLY_ITEMS.map(item => (
 <button
  key={item}
  onClick={() => setForm(f => ({ ...f, supplyItem: item }))}
  className={`py-2 text-sm font-bold tracking-wide rounded-lg border transition-all ${form.supplyItem === item ? 'bg-sky-600/40 text-sky-800 border-sky-500/60' : 'bg-[#FFCE99]/32 text-white/[0.6] border-white/[0.1] hover:text-white/[0.85]'}`}>
  {item === "물" ? "💧 물" : "💊 약"}
 </button>
 ))}
 </div>
 </div>
 ) : (
 <div>
 <span className="sub-label">목적지 노드</span>
 <input value={form.targetNode} onChange={e => setForm(f => ({ ...f, targetNode: e.target.value }))} className="w-full bg-[#FFCE99]/14 border border-white/[0.1] rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/[0.4] focus:outline-none focus:border-white/[0.1]" placeholder="예: 401_7 (지도에서 노드 클릭)" />
 </div>
 )}

 {/* 우선순위 */}
 <div>
 <span className="sub-label">우선순위 <span className="text-white/[0.4] normal-case">(1=긴급 ~ 10=낮음)</span></span>
 <div className="flex items-center gap-2 mt-1">
 <input type="range" min={1} max={10} value={form.priority}
  onChange={e => setForm(f => ({ ...f, priority: +e.target.value }))}
  className="flex-1 accent-sky-500" />
 <span className="text-xs font-bold text-white/80 font-mono w-6 text-center">{form.priority}</span>
 </div>
 </div>

 {/* 추천 로봇 (우선순위순) — 클릭해 지정, 사람이 최종 할당. 공급은 omx 고정이라 숨김 */}
 {isSupply ? (
 <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-sky-500/40 bg-sky-600/15 text-xs">
  <span className="font-mono font-bold text-sky-700">omx</span>
  <span className="text-white/[0.6]">로봇팔 고정 — 공급 전용</span>
 </div>
 ) : (
 <div>
 <span className="sub-label">추천 로봇 {form.targetNode ? "(목적지 기준)" : "(가용성·배터리순)"}</span>
 <div className="space-y-1 mt-1">
 {/* 자동 배정 옵션 */}
 <button onClick={() => setForm(f => ({ ...f, preferredRobotId: "" }))}
  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
   form.preferredRobotId === "" ? "bg-sky-600/20 border-sky-500/50 text-sky-700" : "bg-[#FFCE99]/14 border-white/[0.1] text-white/[0.6] hover:text-white/80"
  }`}>
  <span className="font-semibold">자동 배정</span>
  <span className="text-[9px] text-white/[0.4]">시스템이 선택</span>
 </button>
 {recommendations.map((rec, i) => {
  const selectable = rec.score >= 0;
  const isTop = topPick?.robotId === rec.robotId;
  const selected = form.preferredRobotId === rec.robotId;
  return (
   <button key={rec.robotId}
    disabled={!selectable}
    onClick={() => setForm(f => ({ ...f, preferredRobotId: rec.robotId }))}
    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
     selected ? "bg-sky-600/25 border-sky-500/60"
     : selectable ? "bg-[#FFCE99]/14 border-white/[0.1] hover:border-white/[0.2]"
     : "bg-transparent border-white/[0.06] opacity-45 cursor-not-allowed"
    }`}>
    {/* 순위/추천 뱃지 */}
    {isTop && selectable
     ? <span className="text-[9px] font-bold text-amber-600 flex-none">⭐최우선</span>
     : <span className="text-[10px] font-bold text-white/[0.4] w-5 text-center flex-none">{selectable ? i + 1 : "—"}</span>}
    <span className="font-mono font-bold text-white/85 flex-none">{rec.robotId}</span>
    <span className="text-[10px] text-white/[0.55] truncate flex-1 text-left">{rec.reason}</span>
    {rec.batPct != null && (
     <span className={`text-[10px] font-mono flex-none ${rec.batPct < 20 ? "text-rose-600" : "text-white/[0.55]"}`}>{rec.batPct}%</span>
    )}
   </button>
  );
 })}
 </div>
 </div>
 )}

 {preferredOffline && (
 <p className="text-[10px] text-rose-500 font-semibold text-center -mt-1">
  {preferredId} 오프라인 — 등록/할당 불가
 </p>
 )}
 <div className="grid grid-cols-2 gap-2">
 <button
  onClick={() => submit(emitFmsRegister)}
  disabled={!canSubmit}
  title="배차하지 않고 등록만 — 목록에서 나중에 '배차' 버튼으로 할당"
  className="w-full glass-button !bg-violet-600 hover:!bg-violet-500 !text-xs !font-semibold !tracking-wide !py-2.5 !rounded-xl shadow-xl disabled:opacity-40 disabled:cursor-not-allowed">
  등록만
 </button>
 <button
  onClick={() => submit(emitFmsDispatch)}
  disabled={!canSubmit}
  className="w-full glass-button !bg-sky-600 hover:!bg-sky-500 !text-xs !font-semibold !tracking-wide !py-2.5 !rounded-xl shadow-xl disabled:opacity-40 disabled:cursor-not-allowed">
  {isSupply ? "omx 공급" : form.preferredRobotId ? `${form.preferredRobotId} 할당` : "자동 할당"}
 </button>
 </div>
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
 <span className="text-xs text-white/[0.45] font-semibold tracking-wide mb-1">{label}</span>
 <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
 </div>
 );
}

function RobotStatusCard({ robot, rosMessages, fmsTasks, mapAssignment }: any) {
 const online = isOnline(rosMessages, robot.id);
 const task = fmsTasks.find((t: any) => t.assignedRobotId === robot.id && ["ASSIGNED", "RUNNING"].includes(t.status));
 const bat = (rosMessages[`/${robot.id}/battery_state`]?.data as any)?.percentage;
 const batPct = bat != null ? Math.round(bat > 1 ? bat : bat * 100) : null;

 return (
 <div className={`glass-card p-5 transition-all duration-700 ${online ? 'opacity-100 scale-100 shadow-xl' : 'opacity-40 scale-[0.98]'}`}>
 <div className="flex justify-between items-start mb-4">
 <div>
 <h3 className="text-sm font-bold text-white/90 tracking-wide font-mono">{robot.id}</h3>
 <span className="text-xs text-white/[0.45] tracking-wide">도메인 {robot.domain}</span>
 </div>
 <div className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500 ' : 'bg-[#FFCE99]/32'}`} />
 </div>

 {online ? (
 <div className="space-y-4">
 {batPct !== null && (
 <div className="space-y-1.5">
 <div className="flex justify-between text-xs font-semibold tracking-wide">
 <span className="text-white/[0.45]">배터리</span>
 <span className={batPct < 20 ? "text-white/90" : "text-white/90"}>{batPct}%</span>
 </div>
 <div className="h-1 bg-[#FFCE99]/32 rounded-full overflow-hidden">
 <div className={`h-full rounded-full transition-all duration-1000 ${batPct < 20 ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${batPct}%` }} />
 </div>
 </div>
 )}
 {task ? (
 <div className="p-3 bg-[#FFCE99]/32 border border-white/[0.1] rounded-xl">
 <span className="sub-label !text-xs !mb-1">수행 중 임무</span>
 <div className="flex justify-between items-center">
 <span className="text-xs font-bold text-white/90 ">{taskTypeKo(task.type)}</span>
 <span className="text-xs text-white/[0.6] ">→ {task.targetNode}</span>
 </div>
 </div>
 ) : (
 <div className="text-center py-2 border border-dashed border-white/[0.1] rounded-xl">
 <span className="text-xs font-semibold text-white/[0.4] tracking-wide ">대기 중</span>
 </div>
 )}
 </div>
 ) : (
 <div className="py-8 text-center">
 <span className="text-xs text-white/[0.4] italic">신호 없음…</span>
 </div>
 )}
 </div>
 );
}

function TaskItem({ task, onCancel, onRelease }: any) {
 const isDraft = task.status === 'DRAFT';
 const dotColor = isDraft ? 'bg-violet-400' : task.status === 'RUNNING' ? 'bg-sky-400 animate-pulse' : 'bg-amber-400';
 const badgeColor = isDraft ? 'text-white/90 border-white/[0.1] bg-violet-500/10'
  : task.status === 'RUNNING' ? 'text-white/90 border-white/[0.1] bg-sky-500/5'
  : 'text-white/90 border-white/[0.1] bg-amber-500/5';
 return (
 <div className="glass-card !bg-[#FFCE99]/32 border-white/[0.1] p-4 hover:border-white/[0.1] transition-colors group">
 <div className="flex justify-between items-start mb-2">
 <div className="flex items-center gap-2">
 <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
 <span className="text-xs font-semibold text-white/80 ">{taskTypeKo(task.type)}</span>
 {isDraft && task.preferredRobotId && (
  <span className="text-[10px] font-mono text-white/[0.5]">→ {task.preferredRobotId}</span>
 )}
 </div>
 <button onClick={onCancel} title="태스크 취소" className="text-white/[0.4] hover:text-white/90 transition-colors text-sm leading-none opacity-0 group-hover:opacity-100">✕</button>
 </div>
 <div className="flex justify-between items-end">
 <div className="text-xs text-white/[0.55] tracking-wide">목적지: {task.targetNode}</div>
 <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${badgeColor}`}>{taskStatusKo(task.status)}</span>
 </div>
 {isDraft && (
 <button
  onClick={onRelease}
  className="mt-3 w-full glass-button !bg-sky-600 hover:!bg-sky-500 !text-[11px] !font-semibold !tracking-wide !py-1.5 !rounded-lg shadow-lg">
  배차 (할당 시작)
 </button>
 )}
 </div>
 );
}
