/**
 * ExploreView — Tactical Mission Dashboard
 * Designed for high-blur glassmorphism and atmospheric sepia theme.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import MapCanvas, { MapCanvasHandle } from "../components/MapCanvas";
import CameraFeed from "../components/CameraFeed";
import NlCommandPanel from "../components/NlCommandPanel";
import type { RosMessage, ActiveGoals, MapTimestamps, MapInfos } from "../hooks/useNestSocket";
import type { Socket } from "socket.io-client";

import { BACKEND_URL as BACKEND } from "../config";

const TB3_IDS = ["tb3_01", "tb3_02", "tb3_03", "tb3_04"] as const;
const TB3_LABELS: Record<string, string> = {
 tb3_01: "ALPHA-01", tb3_02: "BRAVO-02", tb3_03: "CHARLIE-03", tb3_04: "DELTA-04",
};

const ROBOT_CAMERA_MAP: Record<string, Array<{ botId: string; label: string }>> = {
 tb3_01: [{ botId: "tb3_01", label: "Front Sensor" }],
 tb3_02: [{ botId: "tb3_02", label: "Front Sensor" }],
 tb3_03: [{ botId: "tb3_03", label: "Front Sensor" }],
 tb3_04: [{ botId: "tb3_04", label: "Front Sensor" }],
 vicpinky: [
 { botId: "vicpinky_cam0", label: "Main Optic" },
 { botId: "vicpinky_cam1", label: "Aux Optic" },
 ],
 omx: [
 { botId: "omx_cam0", label: "Primary Optic" },
 { botId: "omx_cam1", label: "Secondary Optic" },
 ],
};

const OFFLINE_THRESHOLD_MS = 8000;

type EventLevel = "critical" | "warning" | "info";
interface ExploreEvent {
 id: number;
 ts: number;
 botId: string;
 message: string;
 level: EventLevel;
}

function getBotSnapshot(id: string, msgs: Record<string, RosMessage>) {
 const get = (t: string) => msgs[`/${id}/${t}`]?.data;
 const ts = (t: string) => msgs[`/${id}/${t}`]?.timestamp ?? 0;

 const bat = get("battery_state") as { percentage?: number; voltage?: number } | undefined;
 const odom = get("odom") as {
 pose?: { pose?: { position?: { x?: number; y?: number };
 orientation?: { x?: number; y?: number; z?: number; w?: number } } };
 } | undefined;
 const scan = get("scan") as { ranges?: number[]; range_min?: number; range_max?: number;
 angle_min?: number; angle_increment?: number } | undefined;
 const yolo = get("yolo/person_detected") as { data?: boolean } | undefined;
 const mode = (get("mode") as { data?: string } | undefined)?.data ?? "unknown";
 const ss = get("sensor_state") as { bumper?: number; cliff?: number } | undefined;

 const lastMsg = Math.max(ts("battery_state"), ts("odom"), ts("scan"), ts("imu"));
 const online = lastMsg > 0 && Date.now() - lastMsg < OFFLINE_THRESHOLD_MS;

 const batPct = bat?.percentage != null
 ? Math.round(bat.percentage > 1 ? bat.percentage : bat.percentage * 100)
 : null;

 const ori = odom?.pose?.pose?.orientation;
 const yaw = ori
 ? (Math.atan2(2*(ori.w!*ori.z! + ori.x!*ori.y!), 1 - 2*(ori.y!**2 + ori.z!**2)) * 180/Math.PI)
 : null;

 const pos = odom?.pose?.pose?.position;
 const nearest = (scan?.ranges ?? []).filter(r => isFinite(r) && r > 0.1).reduce((m, r) => Math.min(m, r), Infinity);
 const detected = yolo?.data ?? false;

 return { online, batPct, pos, yaw, scan, nearest: isFinite(nearest) ? nearest : null, detected, mode,
 bumper: ss?.bumper ?? 0, cliff: ss?.cliff ?? 0 };
}

interface Props {
 rosMessages: Record<string, RosMessage>;
 activeGoals: ActiveGoals;
 mapTimestamps: MapTimestamps;
 mapInfos: MapInfos;
 socket: Socket | null;
}

export default function ExploreView({ rosMessages, mapTimestamps, mapInfos, socket }: Props) {
 const [selectedBot, setSelectedBot] = useState<string>("tb3_01");
 const [events, setEvents] = useState<ExploreEvent[]>([]);
 const [missionStart] = useState(Date.now());
 const [elapsed, setElapsed] = useState(0);
 const [alertCount, setAlertCount] = useState(0);
 const eventIdRef = useRef(0);
 const prevDetected = useRef<Record<string, boolean>>({});
 const prevOnline = useRef<Record<string, boolean>>({});
 const logRef = useRef<HTMLDivElement>(null);
 const mapCanvasRef = useRef<MapCanvasHandle>(null);
 const [isResetting, setIsResetting] = useState(false);
 const [resetMsg, setResetMsg] = useState<string | null>(null);

 const pushEvent = useCallback((botId: string, message: string, level: EventLevel) => {
 const evt: ExploreEvent = { id: eventIdRef.current++, ts: Date.now(), botId, message, level };
 setEvents(prev => [evt, ...prev].slice(0, 80));
 if (level === "critical") setAlertCount(n => n + 1);
 }, []);

 useEffect(() => {
 const t = setInterval(() => setElapsed(Date.now() - missionStart), 1000);
 return () => clearInterval(t);
 }, [missionStart]);

 const fmtTime = (ms: number) => {
 const s = Math.floor(ms / 1000);
 return `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
 };

 const mapTs = mapTimestamps[selectedBot];
 const mapInfo = mapInfos[selectedBot];
 const mapImageUrl = mapTs ? `${BACKEND}/api/map/${selectedBot}/image?t=${mapTs}` : null;

 const resetMap = useCallback(async () => {
 setIsResetting(true);
 setResetMsg(null);
 try {
 const res = await fetch(`${BACKEND}/api/map/${selectedBot}/reset`, { method: "POST" });
 const json = await res.json() as { ok: boolean; message: string };
 setResetMsg(json.ok ? "Reset Complete" : `Failed: ${json.message}`);
 } catch {
 setResetMsg("Service Error");
 } finally {
 setIsResetting(false);
 setTimeout(() => setResetMsg(null), 4000);
 }
 }, [selectedBot]);

 useEffect(() => {
 TB3_IDS.forEach((id) => {
 const snap = getBotSnapshot(id, rosMessages);
 const label = TB3_LABELS[id];
 if (prevOnline.current[id] !== undefined && prevOnline.current[id] !== snap.online) {
 pushEvent(id, snap.online ? `${label} Uplink Restored` : `${label} Uplink Lost`, snap.online ? "info" : "warning");
 }
 prevOnline.current[id] = snap.online;
 if (snap.online && !prevDetected.current[id] && snap.detected) {
 pushEvent(id, `${label}: TARGET IDENTIFIED — (${snap.pos?.x?.toFixed(1)}, ${snap.pos?.y?.toFixed(1)})`, "critical");
 }
 prevDetected.current[id] = snap.detected;
 });
 }, [rosMessages, pushEvent]);

 const botSnaps = Object.fromEntries(TB3_IDS.map(id => [id, getBotSnapshot(id, rosMessages)]));
 const selectedSnap = botSnaps[selectedBot] ?? getBotSnapshot(selectedBot, rosMessages);
 const totalDetected = TB3_IDS.filter(id => botSnaps[id].detected).length;
 const onlineCount = TB3_IDS.filter(id => botSnaps[id].online).length;

 const isSlam = selectedBot === "project_slam";
 const vpOdom = rosMessages["/vicpinky/odom"]?.data as any;
 const vpPos = vpOdom?.pose?.pose?.position;

 const [activatedBots, setActivatedBots] = useState<Set<string>>(() => new Set([selectedBot]));
 useEffect(() => {
 setActivatedBots(prev => (prev.has(selectedBot) ? prev : new Set(prev).add(selectedBot)));
 }, [selectedBot]);

 return (
 <div className="flex flex-col h-full bg-transparent text-[#521C0D] overflow-hidden relative">
 
 {/* ── Mission Status Bar ─────────────────────────────────────────── */}
 <div className="flex-none flex items-center justify-between px-8 py-4 bg-[#FFCE99]/32 backdrop-blur-3xl border-b border-white/[0.1]">
 <div className="flex items-center gap-8">
 <div className="flex items-center gap-3">
 <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse " />
 <span className="text-white/90 font-semibold text-xs tracking-wide ">Mission Active</span>
 </div>
 <div className="flex items-center gap-3 px-5 py-1.5 bg-[#FFCE99]/32 rounded-xl border border-white/[0.1]">
 <span className="text-xs text-white/[0.45] font-semibold tracking-wide ">Elapsed</span>
 <span className=" text-white/90 text-base font-semibold tabular-nums">{fmtTime(elapsed)}</span>
 </div>
 </div>

 <div className="flex items-center gap-10">
 <StatChip label="Assets Online" value={`${onlineCount}/4`} color={onlineCount > 0 ? "text-white/90" : "text-white/90"} />
 <StatChip label="Targets Spotted" value={String(totalDetected)} color={totalDetected > 0 ? "text-white/90" : "text-white/[0.4]"} />
 <StatChip label="Tactical Alerts" value={String(alertCount)} color={alertCount > 0 ? "text-white/90" : "text-white/[0.4]"} />
 {alertCount > 0 && (
 <button onClick={() => setAlertCount(0)} className="glass-button !px-3 !py-1 text-xs !rounded-md">Reset Feed</button>
 )}
 </div>
 </div>

 <div className="flex flex-col md:flex-row flex-1 overflow-hidden gap-px">
 
 {/* ── Left Sidebar: Fleet Deployment ───────────────────────────── */}
 <aside className="w-full md:w-64 flex-none flex md:flex-col bg-[#FFCE99]/32 backdrop-blur-3xl border-r border-white/[0.1] overflow-y-auto">
 <PanelHeader icon="⬡" label="Asset Deployment" />
 <div className="p-4 space-y-3">
 <DeploymentCard 
 id="project_slam" label="GLOBAL SLAM" type="RVIZ" 
 online={!!rosMessages["/pose"]} isSelected={selectedBot === "project_slam"}
 onClick={() => setSelectedBot("project_slam")}
 />
 <DeploymentCard 
 id="vicpinky" label="VICPINKY" type="CAM×2" 
 online={!!rosMessages["/vicpinky/odom"]} isSelected={selectedBot === "vicpinky"}
 onClick={() => setSelectedBot("vicpinky")}
 telemetry={vpPos ? `(${vpPos.x.toFixed(1)}, ${vpPos.y.toFixed(1)})` : "N/A"}
 />
 <div className="pt-4 pb-1">
 <span className="sub-label">Tactical Units</span>
 </div>
 {TB3_IDS.map(id => (
 <DeploymentCard 
 key={id} id={id} label={TB3_LABELS[id]} type="UNIT"
 online={botSnaps[id].online} isSelected={selectedBot === id}
 onClick={() => setSelectedBot(id)}
 telemetry={botSnaps[id].online ? `${botSnaps[id].batPct}% POW` : "DISCONNECTED"}
 warning={botSnaps[id].detected}
 />
 ))}
 </div>
 </aside>

 {/* ── Center: Tactical Display ─────────────────────────────────── */}
 <main className="flex-1 flex flex-col bg-[#FFCE99]/32 overflow-y-auto min-w-0">
 <div className="p-6 space-y-6">
 <div className="flex items-center justify-between">
 <PanelHeader icon="▣" label={`Tactical Area — ${selectedBot.toUpperCase()}`} />
 <div className="flex items-center gap-3">
 {resetMsg && <span className="text-xs text-white/90 font-bold">{resetMsg}</span>}
 <button onClick={resetMap} disabled={isResetting} className="glass-button !px-4 !py-1.5 !text-xs">
 {isResetting ? "REBOOTING..." : "Reset Data"}
 </button>
 </div>
 </div>

 <div className="flex justify-center">
 <div className="glass-card w-full max-w-3xl p-1 bg-[#FFCE99]/32 border-white/[0.1] ">
 <MapCanvas
 ref={mapCanvasRef}
 imageUrl={mapImageUrl}
 mapInfo={mapInfo}
 robotX={isSlam ? (rosMessages["/pose"]?.data as any)?.pose?.pose?.position?.x : selectedSnap.pos?.x}
 robotY={isSlam ? (rosMessages["/pose"]?.data as any)?.pose?.pose?.position?.y : selectedSnap.pos?.y}
 size={640}
 />
 </div>
 </div>

 <div className="max-w-3xl mx-auto w-full">
 <NlCommandPanel key={selectedBot} botId={selectedBot} socket={socket} />
 </div>
 </div>
 </main>

 {/* ── Right Sidebar: Intel & Timeline ─────────────────────────── */}
 <aside className="w-full md:w-96 flex-none flex flex-col bg-[#FFCE99]/32 backdrop-blur-3xl border-l border-white/[0.1] overflow-hidden">
 <div className="flex-none border-b border-white/[0.1]">
 <PanelHeader icon="◑" label="Intelligence Uplink" />
 <div className="p-6 pt-0 space-y-4">
 {[...activatedBots].map(bot => {
 const cams = ROBOT_CAMERA_MAP[bot] ?? [];
 return (
 <div key={bot} className={bot === selectedBot ? "space-y-4" : "hidden"}>
 {cams.length === 0 ? (
 <div className="aspect-video glass-card flex items-center justify-center opacity-30">
 <span className="text-xs tracking-wide ">No Signal</span>
 </div>
 ) : cams.map(c => <CameraFeed key={c.botId} botId={c.botId} label={c.label} socket={socket} />)}
 </div>
 );
 })}
 </div>
 </div>

 <div className="flex-1 flex flex-col overflow-hidden">
 <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-white/[0.1]">
 <span className="sub-label !mb-0">Mission Timeline</span>
 <span className="text-xs text-white/[0.45] font-bold">{events.length} LOGS</span>
 </div>
 <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-2">
 {events.map(evt => (
 <div key={evt.id} className={`p-4 rounded-xl border transition-all duration-500 ${
 evt.level === "critical" ? "bg-rose-500/10 border-white/[0.1] shadow-lg " :
 evt.level === "warning" ? "bg-amber-500/10 border-white/[0.1]" : "bg-[#FFCE99]/32 border-white/[0.1]"
 }`}>
 <div className="flex justify-between items-start mb-1">
 <span className={`text-xs font-semibold tracking-wide ${
 evt.level === "critical" ? "text-white/90" : evt.level === "warning" ? "text-white/90" : "text-white/[0.45]"
 }`}>{evt.level}</span>
 <span className="text-xs text-white/[0.4]">{new Date(evt.ts).toLocaleTimeString()}</span>
 </div>
 <p className="text-sm text-white/80 font-medium tracking-tight leading-relaxed">{evt.message}</p>
 </div>
 ))}
 </div>
 </div>
 </aside>
 </div>
 </div>
 );
}

function PanelHeader({ icon, label }: { icon: string; label: string }) {
 return (
 <div className="px-6 py-5 flex items-center gap-3">
 <span className="text-white/90/50 font-semibold text-lg">{icon}</span>
 <span className="text-xs font-semibold text-white/[0.75] tracking-wide ">{label}</span>
 </div>
 );
}

function DeploymentCard({ id, label, type, online, isSelected, onClick, telemetry, warning }: any) {
 return (
 <button onClick={onClick} className={`w-full text-left p-4 rounded-2xl border transition-all duration-500 ${
 isSelected ? "bg-white/10 border-white/[0.1] shadow-2xl scale-[1.02]" : "bg-[#FFCE99]/32 border-white/[0.1] hover:border-white/[0.1]"
 }`}>
 <div className="flex justify-between items-center mb-2">
 <div className="flex items-center gap-2">
 <div className={`w-2 h-2 rounded-full ${online ? (warning ? "bg-rose-500 animate-pulse" : "bg-emerald-500") : "bg-[#FFCE99]/32"}`} />
 <span className={`text-xs font-semibold tracking-wider ${isSelected ? "text-white" : "text-white/[0.75]"}`}>{label}</span>
 </div>
 <span className="text-xs text-white/[0.45] font-semibold tracking-wide">{type}</span>
 </div>
 {telemetry && <div className="text-xs text-white/[0.6]">{telemetry}</div>}
 </button>
 );
}

function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
 return (
 <div className="flex flex-col items-center">
 <span className="text-xs text-white/[0.45] font-semibold tracking-wide mb-1">{label}</span>
 <span className={` text-sm font-semibold tabular-nums ${color} tracking-wide`}>{value}</span>
 </div>
 );
}
