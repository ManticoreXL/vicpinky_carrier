import { useState, useRef, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { BACKEND_URL } from "../config";

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface AgentAction {
  tool:   string;
  args:   Record<string, unknown>;
  result: unknown;
}

interface ChatMsg {
  id:       string;
  role:     "user" | "agent";
  text:     string;
  fromMic?: boolean;
  actions?: AgentAction[];
  loading?: boolean;
  error?:   boolean;
}

interface Props {
  socket?: Socket | null;
}

// ── 툴 이름 한글 라벨 ─────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  dispatch_task:    "태스크 디스패치",
  cancel_task:      "태스크 취소",
  get_robots:       "로봇 상태 조회",
  get_nodes:        "노드 목록 조회",
  get_active_tasks: "활성 태스크 조회",
  lock_node:        "노드 잠금",
};

const uid = () => Math.random().toString(36).slice(2);

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function AiAssistant({ socket }: Props) {
  const [open,      setOpen]      = useState(false);
  const [messages,  setMessages]  = useState<ChatMsg[]>([]);
  const [input,     setInput]     = useState("");
  const [recording, setRecording] = useState(false);
  const [interim,   setInterim]   = useState("");

  const mediaRef    = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);

  // 스크롤 바닥 유지
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── 에이전트 호출 ────────────────────────────────────────────────────────────

  const runAgent = useCallback(async (text: string, fromMic = false) => {
    if (!text.trim()) return;

    const userMsgId  = uid();
    const agentMsgId = uid();

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: "user", text, fromMic },
      { id: agentMsgId, role: "agent", text: "", loading: true },
    ]);
    setInput("");

    try {
      const res = await fetch(`${BACKEND_URL}/ai/agent`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text }),
      });

      if (!res.ok) throw new Error(`서버 오류 ${res.status}`);

      const data = (await res.json()) as { reply: string; actions: AgentAction[] };

      setMessages(prev => prev.map(m =>
        m.id === agentMsgId
          ? { ...m, text: data.reply, actions: data.actions, loading: false }
          : m,
      ));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "에이전트 호출 실패";
      setMessages(prev => prev.map(m =>
        m.id === agentMsgId
          ? { ...m, text: msg, loading: false, error: true }
          : m,
      ));
    }
  }, []);

  // ── 마이크 (MediaRecorder → faster-whisper STT) ───────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr     = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];

      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setInterim("");

        const blob    = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", blob, "voice.webm");

        try {
          const res  = await fetch(`${BACKEND_URL}/ai/stt`, { method: "POST", body: formData });
          const data = (await res.json()) as { text: string };
          if (data.text?.trim()) {
            setInput(data.text);
            // NlCommandPanel 등 외부 트리거 호환
            window.dispatchEvent(new CustomEvent("stt-result", {
              detail: { target: "nl-command", text: data.text },
            }));
            // 에이전트로 자동 전송
            await runAgent(data.text, true);
          }
        } catch {
          setMessages(prev => [...prev, { id: uid(), role: "agent", text: "음성 인식 실패", error: true }]);
        }
      };

      mediaRef.current = mr;
      mr.start();
      setRecording(true);
      setInterim("녹음 중…");
    } catch {
      setMessages(prev => [...prev, { id: uid(), role: "agent", text: "마이크 접근 권한이 필요합니다", error: true }]);
    }
  }, [runAgent]);

  const stopRecording = useCallback(() => {
    mediaRef.current?.stop();
    mediaRef.current = null;
    setRecording(false);
  }, []);

  const toggleMic = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  // ── 외부 start-stt 이벤트 호환 ────────────────────────────────────────────

  useEffect(() => {
    const handler = () => void startRecording();
    window.addEventListener("start-stt", handler);
    return () => window.removeEventListener("start-stt", handler);
  }, [startRecording]);

  // ── 전송 ─────────────────────────────────────────────────────────────────

  const send = useCallback(() => {
    void runAgent(input.trim());
  }, [input, runAgent]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* 플로팅 토글 버튼 */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-2xl
          flex items-center justify-center transition-all duration-300
          border border-white/[0.12]
          ${open
            ? "bg-indigo-600 hover:bg-indigo-500 rotate-45"
            : "bg-indigo-700/80 hover:bg-indigo-600/90 backdrop-blur-xl"}`}
        title="EXAONE 에이전트"
      >
        <svg className="w-6 h-6 text-[#FFFDF1]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {open
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15m-6.75-12c.25.023.501.05.75.082M15 19l-3-3m0 0l-3 3m3-3v7" />
          }
        </svg>
      </button>

      {/* 에이전트 패널 */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-96 flex flex-col
          glass-panel border-white/[0.1] shadow-2xl
          rounded-2xl overflow-hidden"
          style={{ maxHeight: "70vh" }}
        >
          {/* 헤더 */}
          <div className="flex-none flex items-center gap-3 px-5 py-4
            border-b border-white/[0.1] bg-indigo-600/10">
            <div className="relative flex-none">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-400" />
              <div className="absolute inset-0 rounded-full bg-indigo-400 animate-ping opacity-40" />
            </div>
            <div>
              <span className="text-sm font-semibold text-white/90 tracking-wide">EXAONE AGENT</span>
              <p className="text-[10px] text-white/[0.55] tracking-widest mt-0.5">AI 자율 실행 에이전트</p>
            </div>
            <button
              onClick={() => setMessages([])}
              className="ml-auto text-xs text-white/[0.45] hover:text-white/[0.68] transition-colors"
            >
              초기화
            </button>
          </div>

          {/* 채팅 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            {messages.length === 0 && (
              <div className="text-center py-8 text-white/[0.45] text-xs leading-relaxed">
                <p className="text-2xl mb-3">🤖</p>
                <p className="font-semibold text-white/[0.55] mb-1">EXAONE 에이전트</p>
                <p>명령을 입력하거나 마이크로 말하세요</p>
                <p className="mt-2 text-white/[0.4]">예: "터틀봇 1번 문앞 노드로 이동"</p>
                <p className="text-white/[0.4]">"현재 활성 태스크 알려줘"</p>
              </div>
            )}
            {messages.map(msg => (
              <MsgBubble key={msg.id} msg={msg} />
            ))}
            {interim && (
              <div className="flex justify-end">
                <span className="text-xs text-rose-600 animate-pulse px-3 py-1.5
                  bg-rose-500/10 rounded-full border border-rose-500/20">
                  {interim}
                </span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* 입력 */}
          <div className="flex-none p-3 border-t border-white/[0.1] bg-[#FFCE99]/32">
            <div className="flex items-center gap-2">
              {/* 마이크 버튼 */}
              <button
                onClick={toggleMic}
                className={`flex-none w-10 h-10 rounded-xl border flex items-center justify-center
                  transition-all active:scale-95
                  ${recording
                    ? "bg-rose-500/30 border-rose-500/50 text-rose-700 animate-pulse"
                    : "bg-[#FFCE99]/32 border-white/[0.1] text-white/[0.6] hover:text-white/[0.82] hover:bg-white/10"
                  }`}
                title={recording ? "녹음 중지" : "음성 명령"}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {recording
                    ? <rect x="6" y="6" width="12" height="12" rx="2" strokeWidth={2} fill="currentColor" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  }
                </svg>
              </button>

              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKey}
                placeholder="명령을 입력하세요…"
                className="flex-1 bg-[#FFCE99]/32 border border-white/[0.1] rounded-xl
                  px-3 py-2.5 text-sm text-white/90 placeholder:text-white/[0.45]
                  focus:outline-none focus:border-indigo-500/40 focus:bg-indigo-500/5"
              />

              <button
                onClick={send}
                disabled={!input.trim()}
                className="flex-none w-10 h-10 rounded-xl bg-indigo-600/80 hover:bg-indigo-500
                  border border-indigo-500/30 text-[#FFFDF1]
                  flex items-center justify-center transition-all active:scale-95
                  disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── 메시지 버블 ───────────────────────────────────────────────────────────────

function MsgBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isUser ? "items-end" : "items-start"} flex flex-col gap-1`}>
        {/* 역할 라벨 */}
        {!isUser && (
          <span className="text-[10px] text-indigo-600 font-semibold tracking-widest px-1">
            EXAONE {msg.fromMic && "🎙"}
          </span>
        )}
        {isUser && msg.fromMic && (
          <span className="text-[10px] text-white/[0.55] text-right px-1">🎙 음성</span>
        )}

        {/* 메시지 본문 */}
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed
          ${isUser
            ? "bg-indigo-600/30 border border-indigo-500/20 text-white/90 rounded-tr-sm"
            : msg.error
              ? "bg-rose-500/15 border border-rose-500/20 text-rose-700 rounded-tl-sm"
              : "bg-[#FFCE99]/32 border border-white/[0.1] text-white/80 rounded-tl-sm"
          }`}
        >
          {msg.loading
            ? <span className="flex items-center gap-2 text-white/[0.6]">
                <span className="flex gap-0.5">
                  {[0,1,2].map(i => (
                    <span key={i} className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </span>
                처리 중…
              </span>
            : <span className="whitespace-pre-wrap">{msg.text}</span>
          }
        </div>

        {/* 실행된 툴 목록 */}
        {msg.actions && msg.actions.length > 0 && (
          <div className="w-full space-y-1">
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-[10px] text-indigo-600/70 hover:text-indigo-600
                flex items-center gap-1 px-1 transition-colors"
            >
              <span>{expanded ? "▾" : "▸"}</span>
              {msg.actions.length}개 액션 실행됨
            </button>
            {expanded && msg.actions.map((a, i) => (
              <ActionCard key={i} action={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 실행 결과 카드 ────────────────────────────────────────────────────────────

function ActionCard({ action }: { action: AgentAction }) {
  const label  = TOOL_LABELS[action.tool] ?? action.tool;
  const result = action.result as any;
  const ok     = result?.ok !== false && !result?.error;

  return (
    <div className={`rounded-xl px-3 py-2.5 border text-xs
      ${ok
        ? "bg-emerald-500/8 border-emerald-500/20"
        : "bg-rose-500/8 border-rose-500/20"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={ok ? "text-emerald-600" : "text-rose-600"}>
          {ok ? "✓" : "✗"}
        </span>
        <span className={`font-semibold tracking-wide ${ok ? "text-emerald-700" : "text-rose-700"}`}>
          {label}
        </span>
      </div>
      {/* 인자 */}
      <div className="text-white/[0.55] mb-1 font-mono">
        {Object.entries(action.args).map(([k, v]) => (
          <span key={k} className="mr-2">
            <span className="text-white/[0.45]">{k}:</span>{" "}
            <span className="text-white/[0.68]">{String(v)}</span>
          </span>
        ))}
      </div>
      {/* 결과 메시지 */}
      {result?.message && (
        <p className={`mt-1 ${ok ? "text-emerald-700/70" : "text-rose-700/70"}`}>
          {result.message}
        </p>
      )}
      {result?.error && (
        <p className="mt-1 text-rose-600">{result.error}</p>
      )}
    </div>
  );
}
