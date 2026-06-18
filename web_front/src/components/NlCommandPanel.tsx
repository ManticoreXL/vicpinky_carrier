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
 const [text, setText] = useState("");
 const [steps, setSteps] = useState<Step[]>([]);
 const [activeIndex, setActiveIndex] = useState(-1);
 const [phase, setPhase] = useState<Phase>("idle");
 const [error, setError] = useState<string | null>(null);

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

 socket.on("nl_command_plan", onPlan);
 socket.on("nl_command_progress", onProgress);
 socket.on("nl_command_done", onDone);
 socket.on("nl_command_stopped", onStopped);
 socket.on("nl_command_error", onError);
 return () => {
 socket.off("nl_command_plan", onPlan);
 socket.off("nl_command_progress", onProgress);
 socket.off("nl_command_done", onDone);
 socket.off("nl_command_stopped", onStopped);
 socket.off("nl_command_error", onError);
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

 // STT 결과 수신
 useEffect(() => {
 const onStt = (e: any) => {
 if (e.detail?.target === "nl-command" && e.detail?.text) {
 setText(e.detail.text);
 }
 };
 window.addEventListener("stt-result", onStt);
 return () => window.removeEventListener("stt-result", onStt);
 }, []);

 const statusText =
 phase === "parsing" ? "명령 해석 중…" :
 phase === "running" ? "실행 중" :
 phase === "done" ? "완료" :
 phase === "stopped" ? "중단됨" :
 phase === "error" ? `오류: ${error ?? ""}` : "";

 const statusColor =
 phase === "error" ? "text-red-600" :
 phase === "running" ? "text-orange-600" :
 phase === "parsing" ? "text-amber-600 animate-pulse" :
 phase === "done" ? "text-emerald-600" :
 phase === "stopped" ? "text-white/[0.6]" : "text-white/[0.55]";

 return (
 <div className="glass-card mt-3 overflow-visible">
 {/* 헤더 */}
 <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.1] bg-orange-500/5">
 <div className="flex items-center gap-2">
 <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />
 <span className="text-xs font-semibold text-white/[0.75] tracking-widest uppercase">
 NL Command — {botId.toUpperCase()}
 </span>
 </div>
 {statusText && (
 <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#FFCE99]/14
                   border border-white/[0.1] ${statusColor}`}>
 {statusText}
 </span>
 )}
 </div>

 {/* 입력 */}
 <div className="flex items-center gap-2 p-3">
 <button
 onClick={() => {
 window.dispatchEvent(new CustomEvent("start-stt", { detail: { target: "nl-command" } }));
 }}
 className={`flex-none w-9 h-9 rounded-lg border flex items-center justify-center transition-all ${
 busy
 ? "border-white/[0.08] text-white/[0.4] cursor-not-allowed bg-[#FFCE99]/32"
 : "border-orange-500/25 text-orange-600 hover:bg-orange-500/15 active:scale-95"
 }`}
 disabled={busy}
 title="음성 명령"
 >
 <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
 d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
 </svg>
 </button>

 <div className="flex-1 relative">
 <input
 value={text}
 onChange={(e) => setText(e.target.value)}
 onKeyDown={(e) => { if (e.key === "Enter") send(); }}
 placeholder='예: "1미터 전진 후 우회전"'
 disabled={busy}
 className="w-full bg-[#FFCE99]/32 border border-white/[0.1] rounded-lg px-3 py-2
 text-sm text-white/90 placeholder:text-white/[0.45]
 focus:outline-none focus:border-orange-500/30 focus:ring-1 focus:ring-orange-500/15
 transition-all disabled:opacity-40"
 />
 {busy && (
 <div className="absolute right-3 top-1/2 -translate-y-1/2">
 <div className="w-3.5 h-3.5 border-2 border-white/[0.1] border-t-orange-500 rounded-full animate-spin" />
 </div>
 )}
 </div>

 {busy ? (
 <button
 onClick={stop}
 className="px-3.5 py-2 text-xs font-semibold tracking-wide rounded-lg
 border border-red-500/30 bg-red-500/10 text-red-600
 hover:bg-red-500/20 transition-all active:scale-95"
 >
 중단
 </button>
 ) : (
 <button
 onClick={send}
 disabled={!socket || !text.trim()}
 className="px-3.5 py-2 text-xs font-semibold tracking-wide rounded-lg
 border border-orange-500/30 bg-orange-500/10 text-orange-600
 hover:bg-orange-500/20 hover:border-orange-500/50 transition-all active:scale-95
 disabled:opacity-20 disabled:cursor-not-allowed"
 >
 실행
 </button>
 )}
 </div>

 {/* 명령 시퀀스 */}
 {steps.length > 0 && (
 <div className="p-3 pt-0 space-y-1">
 <span className="sub-label px-1">실행 시퀀스</span>
 <div className="space-y-1">
 {steps.map((s, i) => {
 const active = i === activeIndex;
 const passed = activeIndex >= 0 && i < activeIndex;
 return (
 <div
 key={i}
 className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-xs transition-all ${
 active
 ? "border-orange-500/30 bg-orange-500/10 text-white/80"
 : passed
 ? "border-white/[0.08] bg-[#FFCE99]/32 text-white/[0.45]"
 : "border-white/[0.1] bg-[#FFCE99]/32 text-white/55"
 }`}
 >
 <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold flex-none ${
 active ? "bg-orange-500 text-black" : passed ? "bg-[#FFCE99]/32 text-white/[0.45]" : "bg-[#FFCE99]/32 text-white/[0.55]"
 }`}>
 {passed ? "✓" : i + 1}
 </div>
 <span className="flex-1 font-medium truncate">{s.desc || `Step ${i+1}`}</span>
 <div className="flex gap-1 text-[10px] opacity-50">
 {s.linear !== 0 && <span className="bg-[#FFCE99]/32 px-1 py-0.5 rounded">{s.linear.toFixed(2)}m/s</span>}
 {s.angular !== 0 && <span className="bg-[#FFCE99]/32 px-1 py-0.5 rounded">{s.angular.toFixed(2)}r/s</span>}
 {s.duration > 0 && <span className="bg-[#FFCE99]/32 px-1 py-0.5 rounded">{s.duration.toFixed(1)}s</span>}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 )}
 </div>
 );
}
