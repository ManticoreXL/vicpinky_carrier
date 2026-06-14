import { useState, useRef, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { BACKEND_URL } from "../config";

type Phase = "idle" | "listening" | "processing" | "done" | "error";

interface Props {
  socket?: Socket | null;
}

export default function AiAssistant({ socket }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalTextRef = useRef("");
  const targetRef = useRef<string | null>(null);

  const isListening = phase === "listening";
  const isProcessing = phase === "processing";

  // ── Web Speech API 초기화 ──────────────────────────────────────────────────
  const buildRecognition = useCallback((): SpeechRecognition | null => {
    const API = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!API) return null;

    const rec = new API();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "ko-KR";

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTextRef.current += t;
          setFinalText(finalTextRef.current);
        } else {
          interim += t;
        }
      }
      setInterimText(interim);
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === "aborted") return;
      setErrMsg(`음성 인식 오류: ${e.error}`);
      setPhase("error");
    };

    rec.onend = () => {
      setInterimText("");
      // recognition이 자동 종료되면(e.g. 침묵) 결과를 처리
      if (phase === "listening") void processText();
    };

    return rec;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── EXAONE 응답 요청 (WebSocket 우선, HTTP fallback) ─────────────────────
  const askExaone = useCallback(async (text: string) => {
    setPhase("processing");
    setAiResponse("");
    setErrMsg("");

    if (socket?.connected) {
      // WebSocket 경로
      socket.once("ai_response", (data: { response?: string; error?: string }) => {
        if (data.error) { setErrMsg(data.error); setPhase("error"); }
        else { setAiResponse(data.response ?? ""); setPhase("done"); }
      });
      socket.emit("ai_ask", { text });
      return;
    }

    // HTTP fallback
    try {
      const res = await fetch(`${BACKEND_URL}/ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("AI 서비스 오류");
      const data = (await res.json()) as { response: string };
      setAiResponse(data.response);
      setPhase("done");
    } catch (err: unknown) {
      setErrMsg(err instanceof Error ? err.message : "처리 실패");
      setPhase("error");
    }
  }, [socket]);

  const processText = useCallback(async () => {
    const text = finalTextRef.current.trim();
    if (!text) { setPhase("idle"); return; }

    // NlCommandPanel 등 외부 타겟에 텍스트 전달
    if (targetRef.current) {
      window.dispatchEvent(new CustomEvent("stt-result", {
        detail: { target: targetRef.current, text },
      }));
      targetRef.current = null;
    }

    await askExaone(text);
  }, [askExaone]);

  // ── 녹음 시작 ─────────────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    const rec = buildRecognition();
    if (!rec) {
      setErrMsg("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)");
      setPhase("error");
      return;
    }
    finalTextRef.current = "";
    setFinalText("");
    setInterimText("");
    setAiResponse("");
    setErrMsg("");
    setPhase("listening");
    recognitionRef.current = rec;
    rec.start();
  }, [buildRecognition]);

  // ── 녹음 중지 ─────────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterimText("");
    void processText();
  }, [processText]);

  // ── 외부 트리거 (NlCommandPanel → start-stt 이벤트) ──────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ target?: string }>;
      targetRef.current = ce.detail?.target ?? null;
      if (!isListening) {
        setIsOpen(true);
        startListening();
      }
    };
    window.addEventListener("start-stt", handler);
    return () => window.removeEventListener("start-stt", handler);
  }, [isListening, startListening]);

  const reset = () => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    finalTextRef.current = "";
    setFinalText("");
    setInterimText("");
    setAiResponse("");
    setErrMsg("");
    setPhase("idle");
  };

  const toggleMic = () => {
    if (isListening) stopListening();
    else startListening();
  };

  const displayText = finalText + (interimText ? interimText : "");

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {/* ── 패널 ─────────────────────────────────────────────────────────── */}
      {isOpen && (
        <div className="w-80 sm:w-96 glass-panel rounded-2xl overflow-hidden shadow-2xl
                        shadow-black/40 border-orange-500/10 animate-slide-up">

          {/* 헤더 */}
          <div className="flex items-center justify-between px-4 py-3
                          border-b border-white/[0.05] bg-orange-500/5">
            <div className="flex items-center gap-2.5">
              <div className={`w-2 h-2 rounded-full transition-colors ${
                isListening ? "bg-orange-500 animate-pulse" :
                isProcessing ? "bg-amber-400 animate-pulse" :
                phase === "done" ? "bg-emerald-500" :
                "bg-white/20"
              }`} />
              <span className="text-[11px] font-semibold tracking-[0.12em] uppercase text-white/50">
                EXAONE Voice Assistant
              </span>
            </div>
            <button
              onClick={() => { reset(); setIsOpen(false); }}
              className="w-6 h-6 flex items-center justify-center rounded text-white/30
                         hover:text-white/70 hover:bg-white/5 transition-all text-lg leading-none"
            >
              ×
            </button>
          </div>

          {/* 전사(Transcription) 영역 */}
          <div className="p-4 min-h-[96px]">
            {!displayText && !isListening && !isProcessing && !aiResponse && !errMsg && (
              <p className="text-xs text-white/25 italic text-center mt-4 leading-relaxed">
                아래 마이크 버튼을 눌러<br />음성 명령을 시작하세요
              </p>
            )}

            {isListening && (
              <div className="flex items-center gap-3 mb-3">
                {/* 파형 애니메이션 */}
                <div className="flex items-end gap-[3px] h-6">
                  {[0.3, 0.6, 1, 0.8, 0.5, 0.9, 0.4].map((delay, i) => (
                    <div
                      key={i}
                      className="wave-bar"
                      style={{ height: `${8 + i * 3}px`, animationDelay: `${delay * 0.4}s` }}
                    />
                  ))}
                </div>
                <span className="text-xs text-orange-400 font-medium">듣는 중...</span>
              </div>
            )}

            {displayText && (
              <div className="mb-3">
                <span className="sub-label">음성 입력</span>
                <p className="text-sm text-white/90 leading-relaxed">
                  {finalText}
                  {interimText && (
                    <span className="text-white/40">{interimText}</span>
                  )}
                </p>
              </div>
            )}

            {isProcessing && (
              <div className="flex items-center gap-2 py-2 border-t border-white/[0.04] mt-2 pt-3">
                <div className="flex items-end gap-[2px] h-5">
                  {[0, 0.2, 0.4].map((d, i) => (
                    <div
                      key={i}
                      className="w-0.5 bg-orange-400/60 rounded-full animate-scale-y"
                      style={{ height: '16px', animationDelay: `${d}s` }}
                    />
                  ))}
                </div>
                <span className="text-xs text-orange-400/80 font-medium">EXAONE 처리 중...</span>
              </div>
            )}

            {aiResponse && (
              <div className="border-t border-white/[0.05] pt-3 mt-2 animate-slide-up">
                <span className="sub-label text-orange-500/60">EXAONE 응답</span>
                <p className="text-xs text-white/75 leading-relaxed whitespace-pre-wrap mt-1">
                  {aiResponse}
                </p>
              </div>
            )}

            {errMsg && (
              <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-xs text-red-400">{errMsg}</p>
              </div>
            )}
          </div>

          {/* 컨트롤 바 */}
          <div className="flex items-center justify-between px-4 py-3
                          border-t border-white/[0.05] bg-black/20">
            <button
              onClick={reset}
              className="text-[11px] text-white/25 hover:text-white/55 transition-colors font-medium"
            >
              지우기
            </button>

            {/* 마이크 버튼 */}
            <div className="relative">
              {isListening && (
                <div className="absolute inset-0 rounded-full bg-orange-500/20 animate-ping" />
              )}
              <button
                onClick={toggleMic}
                disabled={isProcessing}
                className={`relative w-12 h-12 rounded-full flex items-center justify-center
                            shadow-lg transition-all duration-300 disabled:opacity-40 ${
                  isListening
                    ? "bg-orange-500 shadow-orange-500/40 scale-110"
                    : "bg-white/[0.07] hover:bg-white/[0.12] hover:shadow-orange-500/15"
                }`}
              >
                {isListening ? (
                  <div className="flex items-end gap-[3px]">
                    <div className="w-0.5 h-3 bg-white rounded animate-scale-y" />
                    <div className="w-0.5 h-5 bg-white rounded animate-scale-y [animation-delay:0.15s]" />
                    <div className="w-0.5 h-2.5 bg-white rounded animate-scale-y [animation-delay:0.3s]" />
                  </div>
                ) : (
                  <MicIcon className="w-5 h-5 text-white/75" />
                )}
              </button>
            </div>

            <span className="text-[11px] text-white/25 font-medium w-10 text-right">
              {isListening ? "탭하여 완료" : "탭하여 시작"}
            </span>
          </div>
        </div>
      )}

      {/* ── 토글 버튼 ────────────────────────────────────────────────────── */}
      <div className="relative">
        {isListening && (
          <div className="absolute inset-0 rounded-2xl bg-orange-500/20 animate-ping" />
        )}
        <button
          onClick={() => {
            if (!isOpen) setIsOpen(true);
            else if (!isListening && !isProcessing) setIsOpen(false);
          }}
          title="EXAONE 음성 어시스턴트"
          className={`relative w-14 h-14 rounded-2xl flex items-center justify-center
                      shadow-2xl transition-all duration-300 ${
            isOpen || isListening
              ? "bg-orange-500 shadow-orange-500/35"
              : "glass-panel hover:bg-white/[0.08] hover:border-orange-500/20"
          }`}
        >
          <MicIcon className="w-6 h-6 text-white" />
          {(isListening || isProcessing) && (
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-orange-400 animate-pulse" />
          )}
        </button>
      </div>
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );
}
