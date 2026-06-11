import { useEffect, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import CameraFeed from "./CameraFeed";

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface StaticMapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

type NavMode = "view" | "goal" | "pose";

const TB3_ROBOTS = [
  { id: "tb3_01", label: "TB3-01", color: "#3b82f6" },
  { id: "tb3_02", label: "TB3-02", color: "#10b981" },
  { id: "tb3_03", label: "TB3-03", color: "#f59e0b" },
  { id: "tb3_04", label: "TB3-04", color: "#8b5cf6" },
] as const;

// ── 좌표 변환 ─────────────────────────────────────────────────────────────────

function worldToCanvas(wx: number, wy: number, info: StaticMapInfo, scale: number) {
  const col = (wx - info.originX) / info.resolution;
  const row = (info.height - 1) - (wy - info.originY) / info.resolution;
  return { cx: col * scale, cy: row * scale };
}

function canvasToWorld(cx: number, cy: number, info: StaticMapInfo, scale: number) {
  const col = cx / scale;
  const row = cy / scale;
  return {
    wx: info.originX + col * info.resolution,
    wy: info.originY + (info.height - 1 - row) * info.resolution,
  };
}

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages:      Record<string, RosMessage>;
  socket:           Socket | null;
  onSendGoal:       (robotId: string, x: number, y: number, yaw: number) => void;
  onSetInitialPose: (robotId: string, x: number, y: number, yaw: number) => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function NavMapCanvas({ rosMessages, socket, onSendGoal, onSetInitialPose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const infoRef   = useRef<StaticMapInfo | null>(null);
  const scaleRef  = useRef(1);

  const [availableMaps, setAvailableMaps] = useState<string[]>([]);
  const [selectedMap,   setSelectedMap]   = useState<string>("");
  const [mapInfo,       setMapInfo]       = useState<StaticMapInfo | null>(null);
  const [imgLoaded,     setImgLoaded]     = useState(false);
  const [mode,          setMode]          = useState<NavMode>("view");
  const [selectedBot,   setSelectedBot]   = useState("tb3_01");
  const [showCamera,    setShowCamera]    = useState(true);

  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);

  const base = BACKEND_URL.replace(/\/$/, "");

  // ── 맵 목록 로드 ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetch(`${base}/api/map/static/list`)
      .then((r) => r.json())
      .then((list: string[]) => {
        setAvailableMaps(list);
        if (list.length > 0) setSelectedMap(list[0]);
      })
      .catch(console.error);
  }, [base]);

  // ── 선택된 맵 로드 ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedMap) return;
    setImgLoaded(false);
    imgRef.current = null;
    infoRef.current = null;

    fetch(`${base}/api/map/static/${selectedMap}/info`)
      .then((r) => r.json())
      .then((info: StaticMapInfo) => { infoRef.current = info; setMapInfo(info); })
      .catch(console.error);

    const img = new Image();
    img.onload  = () => { imgRef.current = img; setImgLoaded(true); };
    img.onerror = (e) => console.error("맵 이미지 로드 실패", e);
    img.src     = `${base}/api/map/static/${selectedMap}/image`;
  }, [selectedMap, base]);

  // ── 캔버스 렌더 ───────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    const info   = infoRef.current;
    if (!canvas || !img || !info) return;

    const wrap  = wrapRef.current;
    const ww    = wrap?.clientWidth  ?? 600;
    const wh    = wrap?.clientHeight ?? 400;
    const scale = Math.min(ww / info.width, wh / info.height);
    scaleRef.current = scale;

    canvas.width  = Math.floor(info.width  * scale);
    canvas.height = Math.floor(info.height * scale);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // 로봇 마커 (amcl_pose)
    for (const robot of TB3_ROBOTS) {
      const amcl = rosMessages[`/${robot.id}/amcl_pose`]?.data as {
        pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } }
      } | undefined;
      const pos = amcl?.pose?.pose?.position;
      const ori = amcl?.pose?.pose?.orientation;
      if (pos?.x == null) continue;

      const { cx, cy } = worldToCanvas(pos.x, pos.y ?? 0, info, scale);
      const yaw = ori ? quatToYaw({ x: ori.x ?? 0, y: ori.y ?? 0, z: ori.z ?? 0, w: ori.w ?? 1 }) : 0;
      drawRobotMarker(ctx, cx, cy, yaw, robot.color, robot.label, robot.id === selectedBot);
    }

    // 드래그 중 목표 마커
    if (dragRef.current && mode !== "view") {
      const { sx, sy, cx, cy } = dragRef.current;
      const yaw = (Math.abs(cx - sx) + Math.abs(cy - sy)) > 5
        ? Math.atan2(cy - sy, cx - sx)
        : 0;
      drawGoalMarker(ctx, sx, sy, yaw, mode === "goal" ? "#ef4444" : "#22d3ee");
    }
  }, [rosMessages, mode, selectedBot]);

  useEffect(() => { draw(); }, [draw, imgLoaded]);

  useEffect(() => {
    const obs = new ResizeObserver(() => draw());
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, [draw]);

  // ── 마우스 이벤트 ─────────────────────────────────────────────────────────

  const canvasXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === "view") return;
    const { x, y } = canvasXY(e);
    dragRef.current = { sx: x, sy: y, cx: x, cy: y };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const { x, y } = canvasXY(e);
    dragRef.current = { ...dragRef.current, cx: x, cy: y };
    draw();
  };

  const onMouseUp = () => {
    if (!dragRef.current || !infoRef.current) return;
    const { sx, sy, cx, cy } = dragRef.current;
    dragRef.current = null;

    const info  = infoRef.current;
    const scale = scaleRef.current;
    const { wx, wy } = canvasToWorld(sx, sy, info, scale);
    const dx = cx - sx, dy = cy - sy;
    // canvas Y 반전 → ROS yaw
    const yaw = (Math.abs(dx) + Math.abs(dy)) > 5 ? Math.atan2(-dy, dx) : 0;

    if (mode === "goal") onSendGoal(selectedBot, wx, wy, yaw);
    if (mode === "pose") onSetInitialPose(selectedBot, wx, wy, yaw);
    draw();
  };

  const onMouseLeave = () => { dragRef.current = null; draw(); };

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  const selectedRobotMeta = TB3_ROBOTS.find((r) => r.id === selectedBot);

  return (
    <div className="flex flex-col h-full bg-[#050505]">

      {/* ── 툴바 ──────────────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-[#111] bg-[#080808] flex-wrap">

        {/* 맵 선택 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest">MAP</span>
          <select
            value={selectedMap}
            onChange={(e) => setSelectedMap(e.target.value)}
            className="text-[10px] font-mono bg-[#0d0d0d] border border-[#1e1e1e] text-[#aaa] px-2 py-0.5 max-w-[160px] truncate"
          >
            {availableMaps.length === 0 && (
              <option value="">맵 없음</option>
            )}
            {availableMaps.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="w-px h-4 bg-[#1a1a1a]" />

        {/* 로봇 선택 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest">ROBOT</span>
          <div className="flex">
            {TB3_ROBOTS.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedBot(r.id)}
                className={`px-2 py-0.5 text-[9px] font-mono font-bold border-r border-[#1a1a1a] last:border-0 transition-all ${
                  selectedBot === r.id
                    ? "text-[#111] font-black"
                    : "text-[#333] hover:text-[#666] bg-transparent"
                }`}
                style={selectedBot === r.id ? { background: r.color, color: "#000" } : {}}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="w-px h-4 bg-[#1a1a1a]" />

        {/* 모드 */}
        <div className="flex border border-[#1a1a1a] overflow-hidden">
          {([
            { key: "view" as NavMode, label: "보기"     },
            { key: "goal" as NavMode, label: "목표 지점" },
            { key: "pose" as NavMode, label: "초기 위치" },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`px-3 py-1 text-[9px] font-bold uppercase tracking-wider font-mono border-r border-[#1a1a1a] last:border-0 transition-all ${
                mode === key
                  ? key === "goal" ? "text-red-400 bg-[#1a0000]"
                  : key === "pose" ? "text-cyan-400 bg-[#001a1a]"
                  : "text-[#888] bg-[#111]"
                  : "text-[#333] hover:text-[#666]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 카메라 토글 */}
        <button
          onClick={() => setShowCamera((v) => !v)}
          className={`ml-auto px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
            showCamera
              ? "border-green-900/50 text-green-400 bg-green-950/20"
              : "border-[#1a1a1a] text-[#333] hover:text-[#666]"
          }`}
        >
          ◉ CAM
        </button>

        {/* 힌트 */}
        {mode !== "view" && (
          <span className="text-[9px] font-mono text-[#444] italic hidden xl:block">
            {mode === "goal" ? "클릭+드래그 → 목표 전송" : "클릭+드래그 → AMCL 초기화"}
          </span>
        )}
      </div>

      {/* ── 본문: 맵 캔버스 + 카메라 오버레이 ────────────────────────────── */}
      <div ref={wrapRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-[#020202]">

        {/* 맵 캔버스 */}
        {!imgLoaded ? (
          <span className="text-[10px] font-mono text-[#333] uppercase tracking-widest">
            {availableMaps.length === 0 ? "맵 파일 없음" : "맵 로딩 중…"}
          </span>
        ) : (
          <canvas
            ref={canvasRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
            className={mode !== "view" ? "cursor-crosshair" : "cursor-default"}
            style={{ imageRendering: "pixelated", display: "block" }}
          />
        )}

        {/* 카메라 오버레이 (우하단) */}
        {showCamera && socket && (
          <div className="absolute bottom-3 right-3 w-56 z-10 shadow-2xl shadow-black/80 border border-[#222]">
            <div className="flex items-center justify-between px-2 py-1 bg-[#0a0a0a] border-b border-[#1a1a1a]">
              <span
                className="text-[9px] font-mono font-bold uppercase tracking-widest"
                style={{ color: selectedRobotMeta?.color ?? "#888" }}
              >
                ◉ {selectedRobotMeta?.label ?? selectedBot}
              </span>
              <button
                onClick={() => setShowCamera(false)}
                className="text-[9px] text-[#333] hover:text-[#888]"
              >✕</button>
            </div>
            <CameraFeed
              botId={selectedBot}
              label={selectedRobotMeta?.label ?? selectedBot}
              socket={socket}
            />
          </div>
        )}

        {/* 범례 (좌상단) */}
        {imgLoaded && (
          <div className="absolute top-2 left-2 flex flex-col gap-1 bg-[#050505]/80 px-2 py-1.5 border border-[#111]">
            {TB3_ROBOTS.map((r) => {
              const hasPose = rosMessages[`/${r.id}/amcl_pose`]?.data != null;
              return (
                <span key={r.id} className="flex items-center gap-1.5 text-[8px] font-mono">
                  <span
                    className={`w-2 h-2 rounded-full flex-none ${hasPose ? "" : "opacity-30"}`}
                    style={{ background: r.color }}
                  />
                  <span className={hasPose ? "text-[#888]" : "text-[#333]"}>{r.label}</span>
                  {!hasPose && <span className="text-[#2a2a2a]">—</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 하단 정보 바 ─────────────────────────────────────────────────── */}
      {mapInfo && (
        <div className="flex-none flex gap-4 px-3 py-1 border-t border-[#0a0a0a] bg-[#070707] text-[9px] font-mono text-[#2a2a2a]">
          <span className="text-[#333]">{selectedMap}</span>
          <span>{mapInfo.width}×{mapInfo.height}px</span>
          <span>{mapInfo.resolution}m/px</span>
          <span>원점 ({mapInfo.originX.toFixed(2)}, {mapInfo.originY.toFixed(2)})</span>
        </div>
      )}
    </div>
  );
}

// ── 드로잉 헬퍼 ───────────────────────────────────────────────────────────────

function drawRobotMarker(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, yaw: number,
  color: string, label: string, selected: boolean,
) {
  const r = selected ? 8 : 6;
  ctx.save();
  ctx.translate(cx, cy);

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle   = color + (selected ? "cc" : "88");
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = selected ? 2.5 : 1.5;
  ctx.stroke();

  // 방향 화살표 (canvas Y 반전 → -yaw)
  const len = r + 9;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(-yaw) * len, Math.sin(-yaw) * len);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font      = `bold ${selected ? 9 : 8}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText(label, 0, -r - 4);

  ctx.restore();
}

function drawGoalMarker(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, yaw: number, color: string,
) {
  ctx.save();
  ctx.translate(cx, cy);

  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fillStyle   = color + "33";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.setLineDash([3, 2]);
  ctx.stroke();
  ctx.setLineDash([]);

  const len = 22;
  const hx = Math.cos(yaw) * len;
  const hy = Math.sin(yaw) * len;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(hx, hy);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  const a = Math.atan2(hy, hx);
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - 9 * Math.cos(a - 0.4), hy - 9 * Math.sin(a - 0.4));
  ctx.lineTo(hx - 9 * Math.cos(a + 0.4), hy - 9 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();
}
