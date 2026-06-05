/**
 * ExploreView — 재난 탐사 대시보드
 * 기존 관제 기능과 별개로 동작하는 탐사 전용 화면
 */
import { useState, useEffect, useRef, useCallback } from "react";
import MapCanvas, { MapCanvasHandle } from "../components/MapCanvas";
import CameraFeed from "../components/CameraFeed";
import type { RosMessage, ActiveGoals, MapTimestamps, MapInfos } from "../hooks/useNestSocket";
import type { Socket } from "socket.io-client";

const BACKEND = "http://localhost:3001";

// ── 상수 ───────────────────────────────────────────────────────────────────────

const TB3_IDS  = ["tb3_01", "tb3_02", "tb3_03", "tb3_04"] as const;
const TB3_LABELS: Record<string, string> = {
  tb3_01: "TB-01", tb3_02: "TB-02", tb3_03: "TB-03", tb3_04: "TB-04",
};

// 로봇 → 해당 로봇이 가진 카메라 목록 (선택한 로봇의 카메라만 표시)
const ROBOT_CAMERA_MAP: Record<string, Array<{ botId: string; label: string }>> = {
  tb3_01: [{ botId: "tb3_01", label: "TB-01 CAM" }],
  tb3_02: [{ botId: "tb3_02", label: "TB-02 CAM" }],
  tb3_03: [{ botId: "tb3_03", label: "TB-03 CAM" }],
  tb3_04: [{ botId: "tb3_04", label: "TB-04 CAM" }],
  vicpinky: [
    { botId: "vicpinky_cam0", label: "VICPINKY CAM-1" },
    { botId: "vicpinky_cam1", label: "VICPINKY CAM-2" },
  ],
  omx: [
    { botId: "omx_cam0", label: "OMX CAM-1" },
    { botId: "omx_cam1", label: "OMX CAM-2" },
  ],
};

const OFFLINE_THRESHOLD_MS = 8000; // 8초 이상 메시지 없으면 오프라인

// ── 이벤트 타입 ───────────────────────────────────────────────────────────────

type EventLevel = "critical" | "warning" | "info";
interface ExploreEvent {
  id: number;
  ts: number;
  botId: string;
  message: string;
  level: EventLevel;
}

// ── 데이터 추출 헬퍼 ──────────────────────────────────────────────────────────

function getBotSnapshot(id: string, msgs: Record<string, RosMessage>) {
  const get = (t: string) => msgs[`/${id}/${t}`]?.data;
  const ts  = (t: string) => msgs[`/${id}/${t}`]?.timestamp ?? 0;

  const bat  = get("battery_state") as { percentage?: number; voltage?: number } | undefined;
  const odom = get("odom") as {
    pose?: { pose?: { position?: { x?: number; y?: number };
                      orientation?: { x?: number; y?: number; z?: number; w?: number } } };
  } | undefined;
  const scan  = get("scan") as { ranges?: number[]; range_min?: number; range_max?: number;
                                   angle_min?: number; angle_increment?: number } | undefined;
  const yolo  = get("yolo/person_detected") as { data?: boolean } | undefined;
  const mode  = (get("mode") as { data?: string } | undefined)?.data ?? "unknown";
  const ss    = get("sensor_state") as { bumper?: number; cliff?: number } | undefined;

  const lastMsg = Math.max(
    ts("battery_state"), ts("odom"), ts("scan"), ts("imu")
  );
  const online = lastMsg > 0 && Date.now() - lastMsg < OFFLINE_THRESHOLD_MS;

  const batPct = bat?.percentage != null
    ? Math.round(bat.percentage > 1 ? bat.percentage : bat.percentage * 100)
    : null;

  const ori = odom?.pose?.pose?.orientation;
  const yaw = ori
    ? (Math.atan2(2*(ori.w!*ori.z! + ori.x!*ori.y!), 1 - 2*(ori.y!**2 + ori.z!**2)) * 180/Math.PI)
    : null;

  const pos  = odom?.pose?.pose?.position;
  const rMin = scan?.range_min ?? 0.12;
  const rMax = scan?.range_max ?? 3.5;
  const validRanges = (scan?.ranges ?? []).filter(r => isFinite(r) && r >= rMin && r <= rMax);
  const nearest = validRanges.length ? Math.min(...validRanges) : null;
  const detected = yolo?.data ?? false;

  return { online, batPct, batV: bat?.voltage ?? null, pos, yaw, scan, nearest, detected, mode,
           bumper: ss?.bumper ?? 0, cliff: ss?.cliff ?? 0 };
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages: Record<string, RosMessage>;
  activeGoals: ActiveGoals;
  mapTimestamps: MapTimestamps;
  mapInfos: MapInfos;
  socket: Socket | null;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function ExploreView({ rosMessages, activeGoals, mapTimestamps, mapInfos, socket }: Props) {
  const [selectedBot, setSelectedBot] = useState<string>("tb3_01");
  const [events, setEvents]           = useState<ExploreEvent[]>([]);
  const [missionStart]                = useState(Date.now());
  const [elapsed, setElapsed]         = useState(0);
  const [alertCount, setAlertCount]   = useState(0);
  const eventIdRef                    = useRef(0);
  const prevDetected                  = useRef<Record<string, boolean>>({});
  const prevBatWarn                   = useRef<Record<string, boolean>>({});
  const prevObstacle                  = useRef<Record<string, boolean>>({});
  const prevOnline                    = useRef<Record<string, boolean>>({});
  const logRef                        = useRef<HTMLDivElement>(null);
  const mapCanvasRef                  = useRef<MapCanvasHandle>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [resetMsg, setResetMsg]       = useState<string | null>(null);

  const pushEvent = useCallback((botId: string, message: string, level: EventLevel) => {
    const evt: ExploreEvent = { id: eventIdRef.current++, ts: Date.now(), botId, message, level };
    setEvents(prev => [evt, ...prev].slice(0, 80));
    if (level === "critical") setAlertCount(n => n + 1);
  }, []);

  // ── 미션 타이머 ────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - missionStart), 1000);
    return () => clearInterval(t);
  }, [missionStart]);

  const fmtTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  // ── SLAM 맵 (백엔드 PNG 이미지 URL 기반) ────────────────────────────────────
  const mapTs   = mapTimestamps[selectedBot];
  const mapInfo = mapInfos[selectedBot];
  // 타임스탬프가 바뀔 때마다 새 URL → 브라우저 캐시 무력화
  const mapImageUrl = mapTs
    ? `${BACKEND}/api/map/${selectedBot}/image?t=${mapTs}`
    : null;

  const downloadMapPng = useCallback(() => {
    if (!mapTs) return;
    const a = document.createElement("a");
    a.href = `${BACKEND}/api/map/${selectedBot}/image?t=${mapTs}`;
    a.download = `${selectedBot}_slam_map.png`;
    a.click();
  }, [selectedBot, mapTs]);

  const resetMap = useCallback(async () => {
    setIsResetting(true);
    setResetMsg(null);
    try {
      const res = await fetch(`${BACKEND}/api/map/${selectedBot}/reset`, { method: "POST" });
      const json = await res.json() as { ok: boolean; message: string };
      setResetMsg(json.ok ? "초기화 완료" : `실패: ${json.message}`);
    } catch {
      setResetMsg("요청 실패 — 백엔드 확인");
    } finally {
      setIsResetting(false);
      setTimeout(() => setResetMsg(null), 4000);
    }
  }, [selectedBot]);

  const downloadMapNav2 = useCallback(() => {
    if (!mapTs) return;
    const a1 = document.createElement("a");
    a1.href = `${BACKEND}/api/map/${selectedBot}/pgm`;
    a1.download = `${selectedBot}_map.pgm`;
    a1.click();
    setTimeout(() => {
      const a2 = document.createElement("a");
      a2.href = `${BACKEND}/api/map/${selectedBot}/yaml`;
      a2.download = `${selectedBot}_map.yaml`;
      a2.click();
    }, 200);
  }, [selectedBot, mapTs]);

  // ── 이벤트 자동 생성 ────────────────────────────────────────────────────────
  useEffect(() => {
    TB3_IDS.forEach((id) => {
      const snap = getBotSnapshot(id, rosMessages);
      const label = TB3_LABELS[id];

      // 온/오프라인 전환
      if (prevOnline.current[id] !== undefined && prevOnline.current[id] !== snap.online) {
        pushEvent(id, snap.online ? `${label} 온라인` : `${label} 연결 끊김`, snap.online ? "info" : "warning");
      }
      prevOnline.current[id] = snap.online;

      if (!snap.online) return;

      // 인명 감지
      if (!prevDetected.current[id] && snap.detected) {
        pushEvent(id, `${label} 인명 감지 — (${snap.pos?.x?.toFixed(1) ?? "?"}m, ${snap.pos?.y?.toFixed(1) ?? "?"}m)`, "critical");
      }
      prevDetected.current[id] = snap.detected;

      // 배터리 경고
      const batWarn = (snap.batPct ?? 100) < 20;
      if (batWarn && !prevBatWarn.current[id]) {
        pushEvent(id, `${label} 배터리 부족 — ${snap.batPct}%`, "warning");
      }
      prevBatWarn.current[id] = batWarn;

      // 근접 장애물
      const obstacleWarn = snap.nearest !== null && snap.nearest < 0.25;
      if (obstacleWarn && !prevObstacle.current[id]) {
        pushEvent(id, `${label} 장애물 근접 — ${snap.nearest?.toFixed(2)}m`, "warning");
      }
      prevObstacle.current[id] = obstacleWarn;
    });
  }, [rosMessages, pushEvent]);

  // 이벤트 로그 자동 스크롤
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [events.length]);

  // ── 봇별 스냅샷 ─────────────────────────────────────────────────────────────
  const botSnaps = Object.fromEntries(
    TB3_IDS.map(id => [id, getBotSnapshot(id, rosMessages)])
  );
  // selectedBot이 TB3가 아니면(vicpinky/omx) 직접 스냅샷 생성 — undefined 방지
  const selectedSnap = botSnaps[selectedBot] ?? getBotSnapshot(selectedBot, rosMessages);
  const totalDetected = TB3_IDS.filter(id => botSnaps[id].detected).length;
  const onlineCount   = TB3_IDS.filter(id => botSnaps[id].online).length;

  // VicPinky 스냅
  const vpOdom = rosMessages["/vicpinky/odom"]?.data as {
    pose?: { pose?: { position?: { x?: number; y?: number } } }
  } | undefined;
  const vpPos = vpOdom?.pose?.pose?.position;
  const vpScanTs  = rosMessages["/vicpinky/scan"]?.timestamp ?? 0;
  const bpOnline  = vpScanTs > 0 && Date.now() - vpScanTs < OFFLINE_THRESHOLD_MS;

  // 선택한 로봇의 카메라 목록
  const selectedCameras = ROBOT_CAMERA_MAP[selectedBot] ?? [];

  return (
    <div className="flex flex-col h-full bg-[#050505] text-slate-200 overflow-hidden select-none">

      {/* ── 미션 상태 바 ──────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center justify-between px-4 py-2
                      bg-[#0a0f1a] border-b border-red-900/40">
        <div className="flex items-center gap-4">
          <span className="text-red-500 font-black text-xs tracking-[0.3em] uppercase">
            ◉ MISSION ACTIVE
          </span>
          <div className="flex items-center gap-2 text-xs text-[#888888]">
            <span className="text-[#333333]">경과</span>
            <span className="font-mono text-green-400 text-sm tabular-nums">{fmtTime(elapsed)}</span>
          </div>
        </div>

        <div className="flex items-center gap-5 text-xs">
          <StatChip label="온라인" value={`${onlineCount}/4`}
            color={onlineCount === 4 ? "text-green-400" : onlineCount > 0 ? "text-amber-400" : "text-red-500"} />
          <StatChip label="인명 감지" value={String(totalDetected)}
            color={totalDetected > 0 ? "text-red-400" : "text-[#555555]"} urgent={totalDetected > 0} />
          <StatChip label="경보" value={String(alertCount)}
            color={alertCount > 0 ? "text-amber-400" : "text-[#333333]"} />
          {alertCount > 0 && (
            <button onClick={() => setAlertCount(0)}
              className="text-[10px] text-[#333333] hover:text-[#888888] underline transition-colors">
              초기화
            </button>
          )}
        </div>
      </div>

      {/* ── 3열 메인 레이아웃 ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden gap-px bg-red-900/10">

        {/* ── 왼쪽: 함대 상태 ──────────────────────────────────────────── */}
        <aside className="w-52 flex-none flex flex-col bg-[#050505] overflow-y-auto">
          <PanelHeader icon="⬡" label="FLEET STATUS" />

          {/* VicPinky 릴레이 (2개 카메라) — 클릭하면 선택 */}
          <div className="px-3 pb-2">
            <button
              onClick={() => setSelectedBot("vicpinky")}
              className={`w-full text-left rounded-lg p-2.5 border transition-all ${
                selectedBot === "vicpinky"
                  ? "bg-[#0c1a2e] border-blue-600/70 shadow-md shadow-blue-900/20"
                  : bpOnline
                    ? "bg-[#0c1a2e] border-blue-800/40 hover:border-blue-600/50"
                    : "bg-[#0c0c10] border-[#1e1e1e] hover:border-blue-900/40"
              }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <OnlineDot online={bpOnline} color="blue" />
                  <span className="text-xs font-bold text-blue-300">VICPINKY</span>
                </div>
                <span className="text-[10px] text-blue-400/60 font-mono">📷×2</span>
              </div>
              <div className="text-[10px] text-[#555555] space-y-0.5 pl-3.5">
                <div className="flex justify-between">
                  <span>X</span>
                  <span className="text-[#c0c0c0] font-mono">{vpPos?.x != null ? `${vpPos.x.toFixed(2)} m` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Y</span>
                  <span className="text-[#c0c0c0] font-mono">{vpPos?.y != null ? `${vpPos.y.toFixed(2)} m` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>LIDAR</span>
                  <span className={bpOnline ? "text-green-400 font-mono" : "text-[#333333] font-mono"}>
                    {bpOnline ? "수신 중" : "오프라인"}
                  </span>
                </div>
              </div>
            </button>
          </div>

          <div className="px-3 mb-1">
            <p className="text-[9px] text-red-900/80 uppercase tracking-widest font-semibold">탐사 로봇</p>
          </div>

          {/* TB3 카드 */}
          {/* TB3 탐사 로봇 */}
          {TB3_IDS.map((id) => {
            const s = botSnaps[id];
            const isSelected = id === selectedBot;
            return (
              <div key={id} className="px-3 pb-2">
                <button
                  onClick={() => setSelectedBot(id)}
                  className={`w-full text-left rounded-lg p-2.5 border transition-all ${
                    isSelected
                      ? "bg-[#1a0808] border-red-700/60 shadow-md shadow-red-900/20"
                      : s.online
                        ? "bg-[#0a1020] border-slate-700/30 hover:border-red-900/40"
                        : "bg-[#080808] border-[#141414] opacity-60"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <OnlineDot online={s.online} color={s.detected ? "red" : "green"} pulse={s.detected} />
                      <span className={`text-xs font-bold font-mono ${
                        s.detected ? "text-red-400" : s.online ? "text-slate-200" : "text-[#333333]"
                      }`}>{TB3_LABELS[id]}</span>
                    </div>
                    {s.detected && (
                      <span className="text-[9px] bg-red-900/60 text-red-300 px-1.5 py-0.5 rounded font-bold animate-pulse">
                        ⚠ 감지
                      </span>
                    )}
                  </div>

                  {s.online ? (
                    <div className="text-[10px] text-[#555555] space-y-0.5 pl-3.5">
                      <div className="flex justify-between">
                        <span>모드</span>
                        <span className={`font-mono ${
                          s.mode === "explore" ? "text-blue-400" :
                          s.mode === "deliver" ? "text-amber-400" :
                          s.mode === "stop"    ? "text-red-400" : "text-[#555555]"
                        }`}>{s.mode}</span>
                      </div>
                      {s.batPct !== null && (
                        <div className="flex justify-between items-center gap-1">
                          <span>배터리</span>
                          <div className="flex items-center gap-1">
                            <div className="w-12 h-1 bg-slate-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${
                                s.batPct < 20 ? "bg-red-500" : s.batPct < 50 ? "bg-amber-500" : "bg-green-500"
                              }`} style={{ width: `${s.batPct}%` }} />
                            </div>
                            <span className={`font-mono tabular-nums ${
                              s.batPct < 20 ? "text-red-400" : s.batPct < 50 ? "text-amber-400" : "text-green-400"
                            }`}>{s.batPct}%</span>
                          </div>
                        </div>
                      )}
                      {s.nearest !== null && (
                        <div className="flex justify-between">
                          <span>최근접</span>
                          <span className={`font-mono ${s.nearest < 0.3 ? "text-red-400 animate-pulse" : "text-[#c0c0c0]"}`}>
                            {s.nearest.toFixed(2)}m
                          </span>
                        </div>
                      )}
                      {s.pos && (
                        <div className="flex justify-between">
                          <span>위치</span>
                          <span className="font-mono text-[#888888]">
                            ({(s.pos.x ?? 0).toFixed(1)}, {(s.pos.y ?? 0).toFixed(1)})
                          </span>
                        </div>
                      )}
                      {s.bumper !== 0 && (
                        <div className="flex justify-between">
                          <span>충돌</span>
                          <span className="text-red-400 font-bold animate-pulse">⚠ {s.bumper === 1 ? "전방" : s.bumper === 2 ? "후방" : "다중"}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-[10px] text-[#222222] pl-3.5">오프라인</p>
                  )}
                </button>
              </div>
            );
          })}

          {/* OMX (다중 카메라) — 클릭하면 선택 */}
          <div className="px-3 pb-2">
            <button
              onClick={() => setSelectedBot("omx")}
              className={`w-full text-left rounded-lg p-2.5 border transition-all ${
                selectedBot === "omx"
                  ? "bg-purple-950/50 border-purple-600/70 shadow-md shadow-purple-900/20"
                  : "bg-purple-950/30 border-purple-800/40 hover:border-purple-600/50"
              }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <OnlineDot online={true} color="green" />
                  <span className="text-xs font-bold text-purple-300">OMX</span>
                </div>
                <span className="text-[10px] text-purple-400/60 font-mono">📷×2</span>
              </div>
              <div className="text-[10px] text-[#555555] space-y-0.5 pl-3.5">
                <p className="text-purple-400/70">다중 카메라 시스템</p>
              </div>
            </button>
          </div>

          <div className="flex-1" />
        </aside>

        {/* ── 중앙: SLAM 맵 ──────────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col bg-[#050505] overflow-y-auto min-w-0">

          {/* 봇 선택 탭 */}
          <div className="flex-none flex items-center gap-1 px-4 pt-3 pb-2">
            {TB3_IDS.map((id) => {
              const s = botSnaps[id];
              return (
                <button
                  key={id}
                  onClick={() => setSelectedBot(id)}
                  className={`px-3 py-1.5 text-xs font-mono font-bold transition-all border ${
                    selectedBot === id
                      ? "bg-red-950/60 border-red-700/60 text-red-300"
                      : s.online
                        ? "bg-transparent border-slate-700/30 text-[#555555] hover:border-red-900/40 hover:text-[#888888]"
                        : "bg-transparent border-[#141414] text-[#222222] cursor-default"
                  }`}
                >
                  {s.detected && "⚠ "}{TB3_LABELS[id]}
                  <span className={`ml-1.5 text-[8px] ${s.online ? "text-green-500" : "text-[#222222]"}`}>
                    {s.online ? "●" : "○"}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex-1 flex flex-col gap-3 px-4 pb-4">

            {/* 컨트롤 바 */}
            <div className="flex items-center justify-between">
              <PanelHeader icon="▣" label={`SLAM MAP — ${selectedBot.toUpperCase()}`} small />
              <div className="flex items-center gap-1.5">
                {resetMsg && (
                  <span className={`text-[10px] font-mono ${
                    resetMsg.startsWith("실패") || resetMsg.startsWith("요청")
                      ? "text-red-400" : "text-green-400"
                  }`}>{resetMsg}</span>
                )}
                <button onClick={resetMap} disabled={isResetting}
                  className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest border transition-all ${
                    isResetting
                      ? "border-[#1a1a1a] text-[#333333] cursor-not-allowed animate-pulse"
                      : "border-amber-900/50 bg-amber-950/20 text-amber-400 hover:border-amber-700/70 hover:text-amber-300"
                  }`}>
                  {isResetting ? "초기화 중…" : "맵 초기화"}
                </button>
                <div className="w-px h-4 bg-[#222222]" />
                <button onClick={downloadMapPng} disabled={!mapTs}
                  className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest border transition-all ${
                    mapTs ? "border-[#2a2a2a] bg-[#111111] text-[#888888] hover:border-[#444444] hover:text-[#c0c0c0]"
                          : "border-[#1a1a1a] text-[#2a2a2a] cursor-not-allowed"
                  }`}>PNG</button>
                <button onClick={downloadMapNav2} disabled={!mapTs}
                  className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest border transition-all ${
                    mapTs ? "border-red-900/50 bg-red-950/20 text-red-400 hover:border-red-700/70 hover:text-red-300"
                          : "border-[#1a1a1a] text-[#2a2a2a] cursor-not-allowed"
                  }`}>PGM+YAML</button>
              </div>
            </div>

            {/* SLAM 맵 캔버스 — 가득 채움 */}
            <div className="flex justify-center">
              <div className="border border-red-900/30 bg-[#050505] shadow-xl shadow-black/60 w-full max-w-2xl">
                <MapCanvas
                  ref={mapCanvasRef}
                  imageUrl={mapImageUrl}
                  mapInfo={mapInfo}
                  robotX={selectedSnap.pos?.x ?? undefined}
                  robotY={selectedSnap.pos?.y ?? undefined}
                  robotYaw={selectedSnap.yaw != null ? (selectedSnap.yaw * Math.PI) / 180 : undefined}
                  size={560}
                />
              </div>
            </div>

            {/* 맵 메타 정보 */}
            {mapInfo ? (
              <div className="grid grid-cols-3 gap-2 max-w-2xl">
                {[
                  { label: "해상도", val: `${mapInfo.resolution} m/cell` },
                  { label: "크기",   val: `${mapInfo.width} × ${mapInfo.height}` },
                  { label: "영역",   val: `${(mapInfo.width * mapInfo.resolution).toFixed(1)} × ${(mapInfo.height * mapInfo.resolution).toFixed(1)} m` },
                ].map(({ label, val }) => (
                  <div key={label} className="bg-[#0a0f1a] border border-[#1e1e1e] px-2 py-1.5 text-center">
                    <p className="text-[9px] text-[#333333] uppercase">{label}</p>
                    <p className="text-[10px] font-mono text-[#c0c0c0] mt-0.5">{val}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-[#2a2a2a] font-mono py-1">
                /{selectedBot}/map 토픽 대기 중 — Cartographer 실행 확인
              </p>
            )}

          </div>
        </main>

        {/* ── 오른쪽: 카메라 피드 + 이벤트 로그 ────────────────────────── */}
        <aside className="w-96 flex-none flex flex-col bg-[#050505] overflow-hidden">

          {/* 카메라 그리드 — 선택한 로봇의 카메라만 표시 (다중 카메라는 모두 동시 표시) */}
          <div className="flex-none">
            <PanelHeader
              icon="◑"
              label={`CAMERA — ${selectedBot.toUpperCase()}${
                selectedCameras.length > 1 ? ` (${selectedCameras.length})` : ""
              }`}
            />
            <div className="px-3 pb-3 flex flex-col gap-1.5">
              {selectedCameras.length === 0 ? (
                <div className="aspect-video flex items-center justify-center
                                bg-[#050810] border border-[#1e1e1e]">
                  <p className="text-[10px] text-[#2a2a2a] font-mono uppercase tracking-widest">
                    카메라 없음
                  </p>
                </div>
              ) : (
                selectedCameras.map(({ botId, label }) => (
                  <CameraFeed
                    key={botId}
                    botId={botId}
                    label={label}
                    socket={socket}
                  />
                ))
              )}
            </div>
          </div>

          {/* 이벤트 로그 */}
          <div className="flex-1 flex flex-col overflow-hidden border-t border-[#1a1a1a]">
            <div className="flex-none flex items-center justify-between px-3.5 pt-2 pb-1.5">
              <p className="text-[9px] text-red-900/60 uppercase tracking-widest font-semibold">
                ▤ EVENT LOG
              </p>
              <p className="text-[9px] text-[#222222]">{events.length} 건</p>
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto px-3 space-y-1 pb-3">
              {events.length === 0 ? (
                <p className="text-[10px] text-[#222222] text-center py-4">이벤트 없음</p>
              ) : events.map((evt) => (
                <div key={evt.id} className={`px-2.5 py-1.5 border text-[10px] ${
                  evt.level === "critical" ? "bg-red-950/40 border-red-800/40" :
                  evt.level === "warning"  ? "bg-amber-950/30 border-amber-800/30" :
                                             "bg-[#0a0a0a] border-[#1e1e1e]"
                }`}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`font-mono font-bold text-[9px] ${
                      evt.level === "critical" ? "text-red-400" :
                      evt.level === "warning"  ? "text-amber-400" : "text-[#555555]"
                    }`}>
                      {evt.level === "critical" ? "⚠ ALERT" :
                       evt.level === "warning"  ? "△ WARN" : "● INFO"}
                    </span>
                    <span className="text-[#222222] font-mono text-[9px]">
                      {new Date(evt.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-[#c0c0c0]">{evt.message}</p>
                </div>
              ))}
            </div>
          </div>

        </aside>
      </div>
    </div>
  );
}

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────────

function PanelHeader({ icon, label, small }: { icon: string; label: string; small?: boolean }) {
  return (
    <p className={`${small ? "text-[9px]" : "text-[9px]"} font-semibold text-red-900/70
       uppercase tracking-[0.2em] flex items-center gap-1.5 px-3.5
       ${small ? "pb-1.5" : "pt-3 pb-2"}`}>
      <span className="text-red-700">{icon}</span>
      {label}
    </p>
  );
}

function OnlineDot({ online, color = "green", pulse = false }: {
  online: boolean; color?: "green" | "red" | "blue"; pulse?: boolean;
}) {
  const colors = {
    green: online ? "bg-green-500" : "bg-slate-700",
    red:   online ? "bg-red-500"   : "bg-slate-700",
    blue:  online ? "bg-blue-500"  : "bg-slate-700",
  };
  return (
    <div className={`w-2 h-2 rounded-full flex-none ${colors[color]} ${
      online && pulse ? "animate-ping" : ""
    }`} />
  );
}

function StatChip({ label, value, color, urgent }: {
  label: string; value: string; color: string; urgent?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center ${urgent ? "animate-pulse" : ""}`}>
      <span className="text-[#333333] text-[9px] uppercase tracking-widest">{label}</span>
      <span className={`font-mono font-bold text-sm tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

