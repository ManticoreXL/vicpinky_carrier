import { useState } from "react";
import { BACKEND_URL, POLICY_VISION_URL } from "../../config";

// OMX 카메라(perception_server MJPEG 비전) — front/wrist 2대.
// 각 피드: FMS 백엔드 프록시(:3001/api/vision/policy-stream/:cam) → 실패 시 파이 직접(:5000/video_feed/:cam) 자동 폴백.
const CAMS = [
  { cam: "front", label: "Front" },
  { cam: "wrist", label: "Wrist" },
] as const;

export default function PolicyVisionPanel() {
  const [on, setOn] = useState(true);          // 카메라 표시 여부
  const [reloadKey, setReloadKey] = useState(0); // 재연결 시 두 피드 모두 remount
  const reconnect = () => setReloadKey((k) => k + 1);

  return (
    <aside className="w-[460px] max-w-full flex-none flex flex-col bg-[#FFCE99]/14 border-l border-white/[0.1] overflow-hidden">
      <div className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-white/[0.1]">
        <div className="flex items-center gap-2">
          <span className={`text-xs ${on ? "text-rose-600/70 animate-pulse" : "text-white/[0.3]"}`}>◆</span>
          <p className="text-xs font-bold text-white/[0.6] tracking-[0.2em]">OMX 카메라 (Front · Wrist)</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reconnect} className="text-[11px] text-white/[0.5] hover:text-white/80">↻ 재연결</button>
          <button onClick={() => setOn((v) => !v)} className="text-[11px] text-white/[0.5] hover:text-white/80">{on ? "끄기" : "켜기"}</button>
        </div>
      </div>

      <div className="flex-1 p-3 overflow-y-auto">
        {!on ? (
          <div className="flex flex-col items-center justify-center h-64 border border-dashed border-white/[0.12] rounded-lg text-center">
            <span className="text-xs text-white/[0.45]">카메라 꺼짐 — 「켜기」로 표시</span>
          </div>
        ) : (
          <div className="space-y-3">
            {CAMS.map((c) => <CamFeed key={`${c.cam}-${reloadKey}`} cam={c.cam} label={c.label} />)}
          </div>
        )}
      </div>
    </aside>
  );
}

// 카메라 1대 — 백엔드 프록시 우선, 에러 시 파이 직접으로 1회 폴백.
function CamFeed({ cam, label }: { cam: string; label: string }) {
  const [direct, setDirect] = useState(false);
  const [err, setErr] = useState(false);
  const src = direct
    ? `${POLICY_VISION_URL}/video_feed/${cam}`
    : `${BACKEND_URL}/api/vision/policy-stream/${cam}`;
  const onError = () => { if (!direct) setDirect(true); else setErr(true); };

  return (
    <div>
      <div className="flex items-center justify-between mb-1 px-0.5">
        <span className="text-[11px] font-bold text-white/[0.6] tracking-wide">◉ {label}</span>
        <span className="text-[10px] text-white/[0.3]">{direct ? "파이 직접" : "백엔드 경유"}</span>
      </div>
      <div className="w-full aspect-[4/3] bg-black rounded-lg border border-white/[0.1] overflow-hidden">
        {err ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-center gap-1">
            <span className="text-xs text-rose-600/80">{label} 스트림 실패</span>
            <span className="text-[10px] text-white/[0.45]">백엔드·파이 직접 모두 실패</span>
          </div>
        ) : (
          <img src={src} onError={onError} alt={`omx ${cam}`} className="w-full h-full object-contain" />
        )}
      </div>
    </div>
  );
}
