/**
 * ExploreView — Tactical Mission Dashboard
 * Designed for high-blur glassmorphism and atmospheric sepia theme.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import MapCanvas from "../components/MapCanvas";
import NlCommandPanel from "../components/NlCommandPanel";
import { batteryPercent } from "../utils/battery";
import type { RosMessage, ActiveGoals, MapTimestamps, MapInfos, FmsTask, RobotInfo } from "../hooks/useNestSocket";
import type { Socket } from "socket.io-client";

import { BACKEND_URL as BACKEND } from "../config";

// 정찰은 이제 tb3_01 단독 운용 (맵·조난자 보고 모두 tb3_01에서)
const TB3_IDS = ["tb3_01"] as const;
const TB3_LABELS: Record<string, string> = {
 tb3_01: "ALPHA-01",
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

 const batPct = batteryPercent(bat?.percentage);

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
 // 플릿형 지도(NavMapCanvas)용 — VICTIM 노드·토폴로지·경로 등 플릿 기능
 fmsTasks: FmsTask[];
 robots?: RobotInfo[];
 robotStatuses?: Record<string, string>;
 emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 setRobotHome: (robotId: string, x: number, y: number, yaw: number) => void;
 emitNodeLock: (nodeId: string, isLocked: boolean) => void;
 lockedNodes?: Set<string>;
}

export default function ExploreView({
 rosMessages, mapTimestamps, mapInfos, socket,
}: Props) {
 const [selectedBot, setSelectedBot] = useState<string>("tb3_01");
 const [events, setEvents] = useState<ExploreEvent[]>([]);
 const [missionStart] = useState(Date.now());
 const [elapsed, setElapsed] = useState(0);
 const [alertCount, setAlertCount] = useState(0);
 const eventIdRef = useRef(0);
 const prevDetected = useRef<Record<string, boolean>>({});
 const prevOnline = useRef<Record<string, boolean>>({});
 const logRef = useRef<HTMLDivElement>(null);
 const [isResetting, setIsResetting] = useState(false);
 const [resetMsg, setResetMsg] = useState<string | null>(null);
 const [mapStreamOn, setMapStreamOn] = useState(true); // 백엔드 맵 스트림 on/off (tb3_01 SLAM /map 수신 처리)
 // 조난자 사진 — 백엔드(/api/victim/photos)에서 좌표·이미지 폴링 + 수동 동기화(로봇 maps SSH 수신)
 const [victimPhotos, setVictimPhotos] = useState<{ file: string; num: number; x: number; y: number; capturedAt: string; url: string }[]>([]);
 const [photoSyncing, setPhotoSyncing] = useState(false);
 useEffect(() => {
  let alive = true;
  const load = () => fetch(`${BACKEND}/api/victim/photos`).then(r => r.json()).then((d) => { if (alive && Array.isArray(d)) setVictimPhotos(d); }).catch(() => {});
  load();
  const t = setInterval(load, 5000);
  return () => { alive = false; clearInterval(t); };
 }, []);
 const syncPhotos = useCallback(async () => {
  setPhotoSyncing(true);
  try {
   await fetch(`${BACKEND}/api/victim/photos/sync`, { method: "POST" });
   const d = await fetch(`${BACKEND}/api/victim/photos`).then(r => r.json());
   if (Array.isArray(d)) setVictimPhotos(d);
  } catch { /* ignore */ } finally { setPhotoSyncing(false); }
 }, []);
 // 받아온 조난자 사진 전체 초기화 (백엔드 로컬 삭제 + 재동기화 방지. 로봇 원본은 보존)
 const clearPhotos = useCallback(async () => {
  if (!window.confirm("받아온 조난자 사진을 모두 지울까요? (로봇 원본은 보존)")) return;
  setPhotoSyncing(true);
  try {
   await fetch(`${BACKEND}/api/victim/photos`, { method: "DELETE" });
   setVictimPhotos([]);
  } catch { /* ignore */ } finally { setPhotoSyncing(false); }
 }, []);

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

 // 조난자 보고 — /victim/report. std_msgs/String(JSON) 또는 구조화 메시지 모두 처리.
 const victims = useMemo<{ x: number; y: number; radius?: number }[]>(() => {
  const raw = rosMessages["/victim/report"]?.data as any;
  if (!raw) return [];
  let parsed: any = raw;
  if (typeof raw.data === "string") { try { parsed = JSON.parse(raw.data); } catch { return []; } }
  return Array.isArray(parsed?.victims) ? parsed.victims : [];
 }, [rosMessages]);

 // 표시할 "사람"(조난자) — 사진이 있으면 사진 카드, 없으면 좌표만 카드. (카메라 대신 감지된 사람을 보여줌)
 const people = useMemo(() => {
  if (victimPhotos.length > 0) {
   return victimPhotos.map((p) => ({ key: p.file, num: p.num, x: p.x, y: p.y, url: p.url as string | null, capturedAt: p.capturedAt as string | null }));
  }
  return victims.map((v, i) => ({ key: `v${i}`, num: i + 1, x: v.x, y: v.y, url: null as string | null, capturedAt: null as string | null }));
 }, [victimPhotos, victims]);

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

 // 맵 스트림 on/off — 현재 상태 로드 + 토글(백엔드가 /map 처리·전송을 켜고 끔)
 useEffect(() => {
 fetch(`${BACKEND}/api/map/stream`).then(r => r.json()).then((d: { enabled: boolean }) => setMapStreamOn(!!d.enabled)).catch(() => {});
 }, []);
 const toggleMapStream = useCallback(async () => {
 const next = !mapStreamOn;
 setMapStreamOn(next); // 낙관적 반영
 try {
 const r = await fetch(`${BACKEND}/api/map/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
 const d = await r.json() as { enabled: boolean };
 setMapStreamOn(!!d.enabled);
 } catch { setMapStreamOn(!next); }
 }, [mapStreamOn]);

 // 맵 저장 — 백엔드가 생성하는 nav2 호환 pgm + yaml 두 파일을 각각 다운로드
 const saveMap = useCallback(() => {
 const dl = (url: string) => {
 const a = document.createElement("a");
 a.href = url;
 a.download = ""; // 파일명은 서버의 Content-Disposition 사용 (<bot>_map.pgm / .yaml)
 document.body.appendChild(a);
 a.click();
 a.remove();
 };
 dl(`${BACKEND}/api/map/${selectedBot}/pgm`);
 // 일부 브라우저가 연속 다운로드를 막아 약간 지연 후 yaml
 setTimeout(() => dl(`${BACKEND}/api/map/${selectedBot}/yaml`), 400);
 }, [selectedBot]);

 // 라이브 맵을 백엔드 정적 맵으로 저장 → Fleet(NavMapCanvas) 정적맵 목록에 노출
 const saveToFleet = useCallback(async () => {
 const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
 const name = window.prompt("Fleet에 저장할 맵 이름", `${selectedBot}_${stamp}`);
 if (!name) return;
 try {
 const r = await fetch(`${BACKEND}/api/map/${selectedBot}/save-static`, {
 method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
 });
 const d = await r.json() as { ok: boolean; name?: string; message: string };
 setResetMsg(d.ok ? `Fleet 저장: ${d.name}` : `실패: ${d.message}`);
 } catch { setResetMsg("저장 실패"); }
 setTimeout(() => setResetMsg(null), 4000);
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
 const onlineCount = TB3_IDS.filter(id => botSnaps[id].online).length;

 return (
 <div className="flex flex-col h-full bg-transparent text-[#521C0D] overflow-hidden relative">
 
 {/* ── Mission Status Bar ─────────────────────────────────────────── */}
 <div className="flex-none flex items-center justify-between px-8 py-4 bg-[#FFCE99]/32 backdrop-blur-3xl border-b border-white/[0.1]">
 <div className="flex items-center gap-8">
 <div className="flex items-center gap-3">
 <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse " />
 <span className="text-white/90 font-semibold text-xs tracking-wide ">임무 수행 중</span>
 </div>
 <div className="flex items-center gap-3 px-5 py-1.5 bg-[#FFCE99]/32 rounded-xl border border-white/[0.1]">
 <span className="text-xs text-white/[0.45] font-semibold tracking-wide ">경과 시간</span>
 <span className=" text-white/90 text-base font-semibold tabular-nums">{fmtTime(elapsed)}</span>
 </div>
 </div>

 <div className="flex items-center gap-10">
 <StatChip label="정찰 로봇" value={`${onlineCount}/${TB3_IDS.length}`} color={onlineCount > 0 ? "text-white/90" : "text-white/90"} />
 <StatChip label="조난자" value={String(victims.length)} color={victims.length > 0 ? "text-rose-400" : "text-white/[0.4]"} />
 <StatChip label="경보" value={String(alertCount)} color={alertCount > 0 ? "text-white/90" : "text-white/[0.4]"} />
 {alertCount > 0 && (
 <button onClick={() => setAlertCount(0)} className="glass-button !px-3 !py-1 text-xs !rounded-md">경보 초기화</button>
 )}
 </div>
 </div>

 <div className="flex flex-col md:flex-row flex-1 overflow-hidden gap-px">
 
 {/* ── Left Sidebar: Fleet Deployment ───────────────────────────── */}
 <aside className="w-full md:w-64 flex-none flex md:flex-col bg-[#FFCE99]/32 backdrop-blur-3xl border-r border-white/[0.1] overflow-y-auto">
 <PanelHeader icon="⬡" label="정찰 로봇" />
 <div className="p-4 space-y-3">
 {TB3_IDS.map(id => (
 <DeploymentCard
 key={id} id={id} label={TB3_LABELS[id]} type="SCOUT"
 online={botSnaps[id].online} isSelected={selectedBot === id}
 onClick={() => setSelectedBot(id)}
 telemetry={botSnaps[id].online ? `${botSnaps[id].batPct}% 전력` : "연결 끊김"}
 warning={botSnaps[id].detected}
 />
 ))}
 <div className="pt-2 px-1">
 <div className="flex items-center justify-between text-[11px]">
 <span className="text-white/[0.5]">조난자 보고</span>
 <span className={`font-bold ${victims.length ? "text-rose-500" : "text-white/[0.4]"}`}>{victims.length}명</span>
 </div>
 </div>
 </div>
 </aside>

 {/* ── Center: Tactical Display ─────────────────────────────────── */}
 <main className="flex-1 flex flex-col bg-[#FFCE99]/32 overflow-y-auto min-w-0">
 <div className="p-6 space-y-6">
 <div className="flex items-center justify-between">
 <PanelHeader icon="▣" label={`Tactical Area — ${selectedBot.toUpperCase()}`} />
 <div className="flex items-center gap-3">
 {resetMsg && <span className="text-xs text-white/90 font-bold">{resetMsg}</span>}
 <button onClick={toggleMapStream}
 title="맵 스트림 on/off — OFF면 백엔드가 /map(tb3_01 SLAM) 수신 처리·전송을 멈춤(라이브 갱신 정지, 마지막 맵 유지)"
 className="glass-button !px-4 !py-1.5 !text-xs flex items-center gap-1.5">
 <span className={`w-1.5 h-1.5 rounded-full ${mapStreamOn ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
 맵 스트림 {mapStreamOn ? "ON" : "OFF"}
 </button>
 <button onClick={saveMap} disabled={!mapTs} title="현재 맵을 nav2 호환 PGM + YAML 두 파일로 다운로드"
 className="glass-button !px-4 !py-1.5 !text-xs disabled:opacity-40 disabled:cursor-not-allowed">
 저장 (PGM+YAML)
 </button>
 <button onClick={saveToFleet} disabled={!mapTs} title="현재 라이브 맵을 백엔드 정적 맵으로 저장 → Fleet에서 선택 가능"
 className="glass-button !px-4 !py-1.5 !text-xs disabled:opacity-40 disabled:cursor-not-allowed">
 Fleet에 저장
 </button>
 <button onClick={resetMap} disabled={isResetting} className="glass-button !px-4 !py-1.5 !text-xs">
 {isResetting ? "REBOOTING..." : "Reset Data"}
 </button>
 </div>
 </div>

 <div className="flex justify-center">
 <div className="glass-card w-full max-w-3xl p-1 bg-[#FFCE99]/32 border-white/[0.1] ">
 <div className="md:h-[640px] flex items-center justify-center">
 {/* 라이브 SLAM 맵(/api/map/:bot/image) + 조난자 좌표(/victim/report). mapTs로 캐시버스트해 실시간 갱신 */}
 <MapCanvas
 imageUrl={mapTs ? `${BACKEND}/api/map/${selectedBot}/image?t=${mapTs}` : null}
 mapInfo={mapInfo}
 victims={victims}
 size={600}
 />
 </div>
 </div>
 </div>

 {/* 맵 정보 — 해상도/크기/원점/마지막 갱신 (맵 수신 시에만) */}
 {mapInfo ? (
 <div className="max-w-3xl mx-auto w-full flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-white/[0.6] font-mono">
 <span>해상도 {mapInfo.resolution.toFixed(3)} m/px</span>
 <span>크기 {mapInfo.width}×{mapInfo.height} px</span>
 <span>원점 ({mapInfo.origin.position.x.toFixed(2)}, {mapInfo.origin.position.y.toFixed(2)})</span>
 {mapTs && <span>갱신 {new Date(mapTs).toLocaleTimeString()}</span>}
 </div>
 ) : (
 <div className="max-w-3xl mx-auto w-full text-center text-[11px] text-white/[0.4] font-mono">맵 데이터 수신 대기 중…</div>
 )}

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
 {/* 감지된 조난자(사람) — 좌표 + 사진(있으면). 카메라(front sensor)는 제거하고 사람을 보여줌. */}
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-bold text-white/[0.6] tracking-wide">조난자 {people.length > 0 ? `(${people.length})` : ""}</span>
 <div className="flex items-center gap-1.5">
 <button onClick={syncPhotos} disabled={photoSyncing} className="glass-button !px-2.5 !py-1 !text-[10px] !rounded-md disabled:opacity-50">
 {photoSyncing ? "동기화…" : "사진 동기화"}
 </button>
 <button onClick={clearPhotos} disabled={photoSyncing || victimPhotos.length === 0} title="받아온 사진 전체 삭제(로봇 원본 보존)"
 className="glass-button !px-2.5 !py-1 !text-[10px] !rounded-md disabled:opacity-50">
 초기화
 </button>
 </div>
 </div>
 {people.length === 0 ? (
 <div className="text-[11px] text-white/[0.35] py-6 text-center">감지된 조난자가 없습니다</div>
 ) : (
 <div className="grid grid-cols-2 gap-2">
 {people.map((p) => (
 <div key={p.key} className="rounded-lg overflow-hidden border border-white/[0.1] bg-black/20">
 {p.url ? (
 <a href={`${BACKEND}${p.url}`} target="_blank" rel="noreferrer" className="block hover:opacity-90 transition-opacity">
 <img src={`${BACKEND}${p.url}`} alt={`victim ${p.num}`} className="w-full aspect-video object-cover" />
 </a>
 ) : (
 <div className="w-full aspect-video flex items-center justify-center bg-black/20">
 <svg className="w-8 h-8 text-rose-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
 d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
 </svg>
 </div>
 )}
 <div className="px-2 py-1">
 <div className="text-[10px] font-bold text-rose-400">조난자 #{String(p.num).padStart(3, "0")}</div>
 <div className="text-[10px] font-mono text-white/[0.7]">({p.x.toFixed(2)}, {p.y.toFixed(2)})</div>
 {p.capturedAt && <div className="text-[9px] text-white/[0.4]">{p.capturedAt}</div>}
 </div>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>

 <div className="flex-1 flex flex-col overflow-hidden">
 <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-white/[0.1]">
 <span className="sub-label !mb-0">임무 타임라인</span>
 <span className="text-xs text-white/[0.45] font-bold">{events.length}건</span>
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
