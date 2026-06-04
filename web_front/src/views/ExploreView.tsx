/**
 * ExploreView — 재난 탐사 대시보드
 * 기존 관제 기능과 별개로 동작하는 탐사 전용 화면
 */
import { useState, useEffect, useRef, useCallback } from "react";
import LidarCanvas from "../components/explore/LidarCanvas";
import MapCanvas, { MapCanvasHandle } from "../components/MapCanvas";
import type { RosMessage, ActiveGoals, MapTimestamps, MapInfos } from "../hooks/useNestSocket";

const BACKEND = "http://localhost:3001";

// ── 상수 ───────────────────────────────────────────────────────────────────────

const TB3_IDS  = ["tb3_01", "tb3_02", "tb3_03", "tb3_04"] as const;
const TB3_LABELS: Record<string, string> = {
  tb3_01: "TB-01", tb3_02: "TB-02", tb3_03: "TB-03", tb3_04: "TB-04",
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
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function ExploreView({ rosMessages, activeGoals, mapTimestamps, mapInfos }: Props) {
  const [selectedBot, setSelectedBot] = useState<string>("tb3_01");
  const [centerTab, setCenterTab]     = useState<"lidar" | "slam">("lidar");
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
  const selectedSnap = botSnaps[selectedBot];
  const totalDetected = TB3_IDS.filter(id => botSnaps[id].detected).length;
  const onlineCount   = TB3_IDS.filter(id => botSnaps[id].online).length;

  // VicPinky 스냅
  const vpOdom = rosMessages["/vicpinky/odom"]?.data as {
    pose?: { pose?: { position?: { x?: number; y?: number } } }
  } | undefined;
  const vpPos = vpOdom?.pose?.pose?.position;
  const vpScanTs  = rosMessages["/vicpinky/scan"]?.timestamp ?? 0;
  const bpOnline  = vpScanTs > 0 && Date.now() - vpScanTs < OFFLINE_THRESHOLD_MS;

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

          {/* VicPinky 릴레이 */}
          <div className="px-3 pb-2">
            <div className={`rounded-lg p-2.5 border ${bpOnline
              ? "bg-[#0c1a2e] border-blue-800/40"
              : "bg-[#0c0c10] border-[#1e1e1e]"}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <OnlineDot online={bpOnline} color="blue" />
                  <span className="text-xs font-bold text-blue-300">VICPINKY</span>
                </div>
                <span className="text-[10px] text-blue-400/60 font-mono">RELAY</span>
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
            </div>
          </div>

          <div className="px-3 mb-1">
            <p className="text-[9px] text-red-900/80 uppercase tracking-widest font-semibold">탐사 로봇</p>
          </div>

          {/* TB3 카드 */}
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
          <div className="flex-1" />
        </aside>

        {/* ── 중앙: LiDAR + 센서 요약 ───────────────────────────────────── */}
        <main className="flex-1 flex flex-col bg-[#050505] overflow-y-auto min-w-0">

          {/* 봇 선택 탭 + 뷰 토글 */}
          <div className="flex-none flex items-center justify-between gap-2 px-4 pt-3 pb-2">
            {/* 봇 탭 */}
            <div className="flex items-center gap-1">
              {TB3_IDS.map((id) => {
                const s = botSnaps[id];
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedBot(id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold transition-all border ${
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

            {/* LIDAR / SLAM 뷰 토글 */}
            <div className="flex border border-[#222222] overflow-hidden flex-none">
              {(["lidar", "slam"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setCenterTab(tab)}
                  className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest transition-all ${
                    centerTab === tab
                      ? "bg-red-950/50 text-red-400 border-r-0"
                      : "bg-transparent text-[#333333] hover:text-[#666666]"
                  } ${tab === "lidar" ? "border-r border-[#222222]" : ""}`}
                >
                  {tab === "lidar" ? "◎ LIDAR" : "▣ SLAM"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-4 px-4 pb-4">

            {/* ── LIDAR 탭 ──────────────────────────────────────────────── */}
            {centerTab === "lidar" && (
              <>
                <div className="flex flex-col items-center gap-3">
                  <div className="flex items-center justify-between w-full max-w-xs">
                    <PanelHeader icon="◎" label={`LIDAR — ${selectedBot.toUpperCase()}`} small />
                    {selectedSnap.nearest !== null && (
                      <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                        selectedSnap.nearest < 0.3
                          ? "text-red-400 border-red-700/50 bg-red-950/40 animate-pulse"
                          : "text-[#888888] border-slate-700/30"
                      }`}>
                        최근접 {selectedSnap.nearest.toFixed(2)}m
                      </span>
                    )}
                  </div>
                  <div className="bg-[#050505] rounded-xl border border-red-900/20 p-2 shadow-xl shadow-black/50">
                    <LidarCanvas scanData={selectedSnap.scan} size={280} />
                  </div>
                  <div className="grid grid-cols-4 gap-1 w-full text-center">
                    {[
                      { label: "범위", val: selectedSnap.scan ? `${selectedSnap.scan.range_min?.toFixed(2) ?? "?"} ~ ${selectedSnap.scan.range_max?.toFixed(1) ?? "?"}m` : "—" },
                      { label: "포인트", val: selectedSnap.scan?.ranges ? `${(selectedSnap.scan.ranges.filter(r => isFinite(r))).length}` : "—" },
                      { label: "상태", val: selectedSnap.online ? "ON" : "OFF" },
                      { label: "감지", val: selectedSnap.detected ? "DETECT" : "CLEAR" },
                    ].map(({ label, val }) => (
                      <div key={label} className="bg-[#0a0f1a] rounded border border-[#1e1e1e] px-2 py-1.5">
                        <p className="text-[9px] text-[#333333] uppercase">{label}</p>
                        <p className="text-xs font-mono text-[#c0c0c0] mt-0.5">{val}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 센서 요약 그리드 */}
                <div>
                  <PanelHeader icon="▣" label={`SENSOR SUMMARY — ${selectedBot.toUpperCase()}`} small />
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <SensorBox label="위치 (odom)">
                      <DataRow label="X" value={selectedSnap.pos?.x != null ? `${selectedSnap.pos.x.toFixed(3)} m` : "—"} />
                      <DataRow label="Y" value={selectedSnap.pos?.y != null ? `${selectedSnap.pos.y.toFixed(3)} m` : "—"} />
                      <DataRow label="Yaw" value={selectedSnap.yaw != null ? `${selectedSnap.yaw.toFixed(1)}°` : "—"} />
                    </SensorBox>
                    <SensorBox label="배터리">
                      <DataRow label="용량" value={selectedSnap.batPct != null ? `${selectedSnap.batPct}%` : "—"}
                        alert={(selectedSnap.batPct ?? 100) < 20} />
                      <DataRow label="전압" value={selectedSnap.batV != null ? `${selectedSnap.batV.toFixed(2)} V` : "—"} />
                      <DataRow label="상태" value={
                        selectedSnap.batPct == null ? "—" :
                        selectedSnap.batPct < 20 ? "위험" :
                        selectedSnap.batPct < 50 ? "주의" : "정상"
                      } alert={(selectedSnap.batPct ?? 100) < 20} />
                    </SensorBox>
                    <SensorBox label="안전 상태">
                      <DataRow label="장애물" value={selectedSnap.nearest != null ? `${selectedSnap.nearest.toFixed(2)} m` : "—"}
                        alert={selectedSnap.nearest != null && selectedSnap.nearest < 0.3} />
                      <DataRow label="충돌" value={selectedSnap.bumper === 0 ? "없음" : selectedSnap.bumper === 1 ? "전방" : "후방"}
                        alert={selectedSnap.bumper !== 0} />
                      <DataRow label="절벽" value={selectedSnap.cliff ? "감지" : "없음"}
                        alert={!!selectedSnap.cliff} />
                    </SensorBox>
                    <SensorBox label="YOLO 인명 감지">
                      <div className={`flex items-center gap-2 mt-1 px-2 py-1.5 rounded ${
                        selectedSnap.detected
                          ? "bg-red-950/60 border border-red-800/50"
                          : "bg-green-950/30 border border-green-900/30"
                      }`}>
                        <div className={`w-3 h-3 rounded-full ${
                          selectedSnap.detected ? "bg-red-500 animate-ping" : "bg-green-600"
                        }`} />
                        <span className={`text-sm font-bold ${selectedSnap.detected ? "text-red-400" : "text-green-400"}`}>
                          {selectedSnap.detected ? "인명 감지" : "이상 없음"}
                        </span>
                      </div>
                    </SensorBox>
                  </div>
                </div>
              </>
            )}

            {/* ── SLAM 탭 ───────────────────────────────────────────────── */}
            {centerTab === "slam" && (
              <div className="flex flex-col gap-3">
                {/* 헤더 + 다운로드 버튼 */}
                <div className="flex items-center justify-between">
                  <PanelHeader icon="▣" label={`SLAM MAP — ${selectedBot.toUpperCase()}`} small />
                  <div className="flex gap-1.5">
                    <button
                      onClick={downloadMapPng}
                      disabled={!mapTs}
                      className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest border transition-all ${
                        mapTs
                          ? "border-[#2a2a2a] bg-[#111111] text-[#888888] hover:border-[#444444] hover:text-[#c0c0c0]"
                          : "border-[#1a1a1a] text-[#2a2a2a] cursor-not-allowed"
                      }`}
                    >
                      PNG 저장
                    </button>
                    <button
                      onClick={downloadMapNav2}
                      disabled={!mapTs}
                      className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest border transition-all ${
                        mapTs
                          ? "border-red-900/50 bg-red-950/20 text-red-400 hover:border-red-700/70 hover:text-red-300"
                          : "border-[#1a1a1a] text-[#2a2a2a] cursor-not-allowed"
                      }`}
                    >
                      PGM + YAML
                    </button>
                  </div>
                </div>

                {/* 맵 캔버스 */}
                <div className="flex justify-center">
                  <div className="border border-red-900/30 bg-[#050505] p-1 shadow-xl shadow-black/60">
                    <MapCanvas
                      ref={mapCanvasRef}
                      imageUrl={mapImageUrl}
                      mapInfo={mapInfo}
                      robotX={selectedSnap.pos?.x ?? undefined}
                      robotY={selectedSnap.pos?.y ?? undefined}
                      robotYaw={selectedSnap.yaw != null ? (selectedSnap.yaw * Math.PI) / 180 : undefined}
                      size={320}
                    />
                  </div>
                </div>

                {/* 맵 메타 정보 */}
                {mapInfo ? (
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "해상도", val: `${mapInfo.resolution} m/cell` },
                      { label: "크기", val: `${mapInfo.width} × ${mapInfo.height}` },
                      { label: "영역", val: `${(mapInfo.width * mapInfo.resolution).toFixed(1)} × ${(mapInfo.height * mapInfo.resolution).toFixed(1)} m` },
                    ].map(({ label, val }) => (
                      <div key={label} className="bg-[#0a0f1a] border border-[#1e1e1e] px-2 py-1.5 text-center">
                        <p className="text-[9px] text-[#333333] uppercase">{label}</p>
                        <p className="text-[10px] font-mono text-[#c0c0c0] mt-0.5">{val}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-[#2a2a2a] font-mono text-center py-2">
                    /{selectedBot}/map 토픽 대기 중 — Cartographer 실행 확인
                  </p>
                )}
              </div>
            )}

          </div>
        </main>

        {/* ── 오른쪽: 감지 현황 + 이벤트 로그 ──────────────────────────── */}
        <aside className="w-64 flex-none flex flex-col bg-[#050505] overflow-hidden">

          {/* 인명 감지 현황 */}
          <div className="flex-none">
            <PanelHeader icon="◈" label="DETECTION FEED" />
            <div className="px-3 pb-3 space-y-1">
              {TB3_IDS.map((id) => {
                const s = botSnaps[id];
                return (
                  <div key={id} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                    !s.online
                      ? "bg-[#080808] border-[#141414]"
                      : s.detected
                        ? "bg-red-950/50 border-red-700/50 shadow-sm shadow-red-900/30"
                        : "bg-[#0a0a0a] border-[#1e1e1e]"
                  }`}>
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${
                        !s.online ? "bg-slate-700" :
                        s.detected ? "bg-red-500 animate-ping" : "bg-green-600"
                      }`} />
                      <span className={`text-xs font-mono font-semibold ${
                        !s.online ? "text-[#333333]" :
                        s.detected ? "text-red-300" : "text-[#c0c0c0]"
                      }`}>{TB3_LABELS[id]}</span>
                    </div>
                    <span className={`text-[10px] font-bold ${
                      !s.online ? "text-[#222222]" :
                      s.detected ? "text-red-400" : "text-green-500"
                    }`}>
                      {!s.online ? "OFFLINE" : s.detected ? "⚠ PERSON" : "✓ CLEAR"}
                    </span>
                  </div>
                );
              })}

              {/* 감지 합계 */}
              <div className={`mt-1 px-3 py-2 rounded-lg border text-center ${
                totalDetected > 0
                  ? "bg-red-950/40 border-red-800/50"
                  : "bg-[#0a0a0a] border-[#1e1e1e]"
              }`}>
                <p className="text-[10px] text-[#555555] uppercase tracking-widest">Total Detected</p>
                <p className={`text-2xl font-black font-mono mt-0.5 ${
                  totalDetected > 0 ? "text-red-400" : "text-[#333333]"
                }`}>{totalDetected}</p>
              </div>
            </div>
          </div>

          {/* 미래: 카메라 피드 플레이스홀더 */}
          <div className="flex-none px-3 pb-3">
            <p className="text-[9px] text-red-900/60 uppercase tracking-widest font-semibold mb-1.5 px-0.5">
              ◑ CAMERA FEED
            </p>
            <div className="bg-[#050810] border border-[#1e1e1e] rounded-lg flex items-center
                            justify-center aspect-video">
              <div className="text-center">
                <p className="text-[#222222] text-xs font-mono">[ NO SIGNAL ]</p>
                <p className="text-slate-800 text-[9px] mt-1">Depth Camera</p>
                <p className="text-slate-800 text-[9px]">준비 중...</p>
              </div>
            </div>
          </div>

          {/* 이벤트 로그 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-none flex items-center justify-between px-3.5 pb-1.5">
              <p className="text-[9px] text-red-900/60 uppercase tracking-widest font-semibold">
                ▤ EVENT LOG
              </p>
              <p className="text-[9px] text-[#222222]">{events.length} 건</p>
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto px-3 space-y-1 pb-3">
              {events.length === 0 ? (
                <p className="text-[10px] text-[#222222] text-center py-4">이벤트 없음</p>
              ) : events.map((evt) => (
                <div key={evt.id} className={`px-2.5 py-1.5 rounded border text-[10px] ${
                  evt.level === "critical"
                    ? "bg-red-950/40 border-red-800/40"
                    : evt.level === "warning"
                      ? "bg-amber-950/30 border-amber-800/30"
                      : "bg-[#0a0a0a] border-[#1e1e1e]"
                }`}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`font-mono font-bold text-[9px] ${
                      evt.level === "critical" ? "text-red-400" :
                      evt.level === "warning"  ? "text-amber-400" : "text-[#555555]"
                    }`}>
                      {evt.level === "critical" ? "⚠ ALERT" :
                       evt.level === "warning"  ? "△ WARN"  : "● INFO"}
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

function SensorBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0a0f1a] border border-[#1e1e1e] rounded-lg px-3 py-2">
      <p className="text-[9px] text-[#333333] uppercase tracking-widest mb-1.5">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DataRow({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-[#333333]">{label}</span>
      <span className={`font-mono ${alert ? "text-red-400 font-bold" : "text-[#c0c0c0]"}`}>{value}</span>
    </div>
  );
}
