import { useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import CameraFeed from "./CameraFeed";

// ── 로봇별 카메라 목록 매핑 ─────────────────────────────────────────────────
// 터틀봇 1개 / 빅핑키 2개 / omx 2개
const ROBOT_CAMERAS: Record<string, Array<{ botId: string; label: string }>> = {
  tb3_01:   [{ botId: "tb3_01", label: "터틀봇 1" }],
  tb3_02:   [{ botId: "tb3_02", label: "터틀봇 2" }],
  tb3_03:   [{ botId: "tb3_03", label: "터틀봇 3" }],
  tb3_04:   [{ botId: "tb3_04", label: "터틀봇 4" }],
  vicpinky: [
    { botId: "vicpinky_cam0", label: "VicPinky CAM-1" },
    { botId: "vicpinky_cam1", label: "VicPinky CAM-2" },
  ],
  omx: [
    { botId: "omx_cam0", label: "OMX CAM-1" },
    { botId: "omx_cam1", label: "OMX CAM-2" },
  ],
};

const ROBOT_LABEL: Record<string, string> = {
  tb3_01:   "터틀봇 1",
  tb3_02:   "터틀봇 2",
  tb3_03:   "터틀봇 3",
  tb3_04:   "터틀봇 4",
  vicpinky: "VicPinky",
  omx:      "OMX",
};

interface Props {
  selectedRobot: string;
  socket: Socket | null;
}

export default function ControlCameraPanel({ selectedRobot, socket }: Props) {
  const cameras = ROBOT_CAMERAS[selectedRobot] ?? [{ botId: selectedRobot, label: selectedRobot }];
  const label = ROBOT_LABEL[selectedRobot] ?? selectedRobot;
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <aside className="w-[460px] flex-none flex flex-col bg-[#060606] border-l border-red-900/20 overflow-hidden">

      {/* ── 헤더 ─────────────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <span className="text-red-700/60 text-[8px]">◆</span>
          <p className="text-[9px] font-mono font-bold text-[#444444] uppercase tracking-[0.25em]">
            CAMERA FEED
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-red-500/70 uppercase tracking-widest">
            {label}{cameras.length > 1 ? ` · ${cameras.length}CH` : ""}
          </span>
          <button
            onClick={toggleFullscreen}
            title="전체화면"
            className="text-[#333333] hover:text-[#888888] transition-colors text-[11px]"
          >
            {isFullscreen ? "⊠" : "⊞"}
          </button>
        </div>
      </div>

      {/* ── 카메라 (선택 로봇의 모든 채널) ──────────────────────────────── */}
      <div ref={containerRef} className="flex-none p-3 bg-[#050505] flex flex-col gap-3 overflow-y-auto">
        {cameras.map(({ botId, label: camLabel }) => (
          <CameraFeed key={botId} botId={botId} label={camLabel} socket={socket} />
        ))}
      </div>

      {/* ── 카메라 정보 ───────────────────────────────────────────────────── */}
      <div className="flex-none px-4 py-2 border-t border-[#111111]">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {[
            { label: "채널 수",  val: `${cameras.length}` },
            { label: "프로토콜", val: "WebRTC" },
            { label: "코덱",     val: "H.264" },
            { label: "지연",     val: "Low-Latency" },
          ].map(({ label: l, val }) => (
            <div key={l} className="flex justify-between text-[9px] font-mono">
              <span className="text-[#333333]">{l}</span>
              <span className="text-[#555555]">{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 하단 여백 (추후 PTZ 컨트롤 등 확장) ─────────────────────────── */}
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[9px] font-mono text-[#1a1a1a] uppercase tracking-widest">
          PTZ CONTROL — 준비 중
        </p>
      </div>

    </aside>
  );
}
