import { useEffect, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface Step {
  linear: number;
  angular: number;
  duration: number;
  desc: string;
}
type Phase = "idle" | "parsing" | "running" | "done" | "stopped" | "error";

interface Props {
  botId: string;
  socket: Socket | null;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function NlCommandPanel({ botId, socket }: Props) {
  const [text, setText]               = useState("");
  const [steps, setSteps]             = useState<Step[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [phase, setPhase]             = useState<Phase>("idle");
  const [error, setError]             = useState<string | null>(null);

  // ── 소켓 이벤트 수신 (해당 로봇만) ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onPlan = (d: { botId: string; steps: Step[] }) => {
      if (d.botId !== botId) return;
      setSteps(d.steps);
      setActiveIndex(-1);
      setPhase("running");
    };
    const onProgress = (d: { botId: string; index: number }) => {
      if (d.botId !== botId) return;
      setActiveIndex(d.index);
    };
    const onDone = (d: { botId: string }) => {
      if (d.botId !== botId) return;
      setActiveIndex(-1);
      setPhase("done");
    };
    const onStopped = (d: { botId: string }) => {
      if (d.botId !== botId) return;
      setActiveIndex(-1);
      setPhase("stopped");
    };
    const onError = (d: { botId: string; message: string }) => {
      if (d.botId !== botId) return;
      setPhase("error");
      setError(d.message);
    };

    socket.on("nl_command_plan",     onPlan);
    socket.on("nl_command_progress", onProgress);
    socket.on("nl_command_done",     onDone);
    socket.on("nl_command_stopped",  onStopped);
    socket.on("nl_command_error",    onError);
    return () => {
      socket.off("nl_command_plan",     onPlan);
      socket.off("nl_command_progress", onProgress);
      socket.off("nl_command_done",     onDone);
      socket.off("nl_command_stopped",  onStopped);
      socket.off("nl_command_error",    onError);
    };
  }, [socket, botId]);

  // ── 명령 전송 / 중단 ────────────────────────────────────────────────────────
  const send = useCallback(() => {
    if (!socket || !text.trim() || phase === "parsing" || phase === "running") return;
    setSteps([]);
    setActiveIndex(-1);
    setError(null);
    setPhase("parsing");
    socket.emit("nl_command", { botId, text: text.trim() });
  }, [socket, text, phase, botId]);

  const stop = useCallback(() => {
    socket?.emit("nl_command_stop", { botId });
  }, [socket, botId]);

  const busy = phase === "parsing" || phase === "running";

  const statusText =
    phase === "parsing" ? "명령 해석 중…" :
    phase === "running" ? "실행 중" :
    phase === "done"    ? "완료" :
    phase === "stopped" ? "중단됨" :
    phase === "error"   ? `오류: ${error ?? ""}` : "";

  const statusColor =
    phase === "error"   ? "text-red-400" :
    phase === "running" ? "text-amber-400" :
    phase === "parsing" ? "text-cyan-400 animate-pulse" :
    phase === "done"    ? "text-green-400" :
    phase === "stopped" ? "text-[#888888]" : "text-[#444444]";

  return (
    <div className="border border-[#1e1e1e] bg-[#070707]">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#161616]">
        <span className="text-[9px] font-mono font-bold text-cyan-700 uppercase tracking-[0.2em]">
          ◈ 자연어 명령 — {botId.toUpperCase()}
        </span>
        {statusText && (
          <span className={`text-[9px] font-mono ${statusColor}`}>{statusText}</span>
        )}
      </div>

      {/* 입력 */}
      <div className="flex items-center gap-1.5 p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder='예: "1미터 앞으로 갔다가 오른쪽으로 돌아"'
          disabled={busy}
          className="flex-1 bg-[#0c0c0c] border border-[#222222] px-2.5 py-1.5
                     text-[11px] text-slate-200 font-mono placeholder:text-[#333333]
                     focus:outline-none focus:border-cyan-800/60 disabled:opacity-50"
        />
        {busy ? (
          <button
            onClick={stop}
            className="px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest
                       border border-red-800/60 bg-red-950/40 text-red-400
                       hover:border-red-600 hover:text-red-300 transition-all"
          >
            정지
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!socket || !text.trim()}
            className="px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest
                       border border-cyan-800/60 bg-cyan-950/30 text-cyan-400
                       hover:border-cyan-600 hover:text-cyan-300 transition-all
                       disabled:opacity-30 disabled:cursor-not-allowed"
          >
            전송
          </button>
        )}
      </div>

      {/* 명령 시퀀스 */}
      {steps.length > 0 && (
        <div className="px-2 pb-2 space-y-1">
          {steps.map((s, i) => {
            const active = i === activeIndex;
            const passed = activeIndex >= 0 && i < activeIndex;
            return (
              <div
                key={i}
                className={`flex items-center gap-2 px-2 py-1 border text-[10px] font-mono transition-all ${
                  active
                    ? "border-amber-600/70 bg-amber-950/30 text-amber-300"
                    : passed
                      ? "border-[#161616] bg-[#0a0a0a] text-[#555555]"
                      : "border-[#1a1a1a] bg-[#0c0c0c] text-[#888888]"
                }`}
              >
                <span className={`w-4 text-center ${active ? "text-amber-400" : "text-[#333333]"}`}>
                  {passed ? "✓" : active ? "▶" : i + 1}
                </span>
                <span className="flex-1">{s.desc || `이동`}</span>
                <span className="text-[#444444] tabular-nums">
                  {s.linear !== 0 && `${s.linear.toFixed(2)}m/s `}
                  {s.angular !== 0 && `${s.angular.toFixed(2)}r/s `}
                  {s.duration > 0 && `${s.duration.toFixed(1)}s`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
