import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Socket } from "socket.io-client";
import type { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskManagerAlert } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";

// ── 상수 ──────────────────────────────────────────────────────────────────────

const ROBOTS = [
  { id: "vicpinky", label: "VIC-PINKY",     domain: 40, type: "carrier" },
  { id: "tb3_01",   label: "UNIT-ALPHA",     domain: 41, type: "tb3" },
  { id: "tb3_02",   label: "UNIT-BRAVO",     domain: 42, type: "tb3" },
  { id: "tb3_03",   label: "UNIT-CHARLIE",   domain: 43, type: "tb3" },
  { id: "tb3_04",   label: "UNIT-DELTA",     domain: 44, type: "tb3" },
  { id: "omx",      label: "OMX-ARM",         domain: 45, type: "arm" },
] as const;

const TASK_COLORS: Record<string, string> = {
  SUPPLY:      "bg-sky-500/10 border-sky-500/30 text-sky-300",
  PROCESS:     "bg-violet-500/10 border-violet-500/30 text-violet-300",
  CHARGE:      "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  MOVE:        "bg-white/5 border-white/10 text-white/50",
};

const STATUS_DOT: Record<string, string> = {
  PENDING:   "bg-amber-400",
  ASSIGNED:  "bg-sky-400",
  RUNNING:   "bg-emerald-400 animate-pulse",
  COMPLETED: "bg-white/30",
  FAILED:    "bg-rose-400",
};

const ONLINE_MS = 5000;

// Task Manager 전용 시스템 프롬프트 (RAG 컨텍스트는 백엔드에서 자동 삽입)
const TASK_SYSTEM_PROMPT = `당신은 로봇 플릿 관리 시스템(FMS) AI 어시스턴트입니다.
운영자의 입력을 분석하여 태스크 명령인지 질문인지 판단하고 JSON으로만 응답하세요.

[태스크 유형]
SUPPLY=공급, PROCESS=작업, CHARGE=충전, MOVE=이동

태스크 명령인 경우:
{"isTask":true,"type":"SUPPLY","targetNode":"401_7","preferredRobotId":"tb3_01","priority":5,"explanation":"설명"}

질문/상태확인인 경우 (DB 데이터를 기반으로 정확하게 답변):
{"isTask":false,"answer":"답변 내용"}

preferredRobotId는 명시적으로 언급되지 않으면 반드시 null. priority는 1(긴급)~10(낮음), 기본 5.
반드시 JSON만 출력, 다른 텍스트 절대 금지.`;

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  streaming?: boolean;
  tokenCount?: number;
  elapsedMs?: number;
  tps?: number;
  parsed?: ParsedTask;
  dismissed?: boolean;
  fromStt?: boolean; // 음성 입력 여부 표시
}

interface ParsedTask {
  type: TaskType;
  targetNode: string;
  preferredRobotId: string | null;
  priority: number;
  explanation: string;
}

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  socket: Socket | null;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsCancel: (taskId: string) => void;
  robotStatuses: Record<string, string>;
  tmAlerts: TaskManagerAlert[];
  ackTmAlert: (alertId: string) => void;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
  const topic = robotId === "omx" ? `/${robotId}/joint_states` : `/${robotId}/odom`;
  const msg = rosMessages[topic];
  return !!msg && Date.now() - msg.timestamp < ONLINE_MS;
}

function uid() { return Math.random().toString(36).slice(2, 9); }

// ── STT 훅 ────────────────────────────────────────────────────────────────────

function useMic(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim]     = useState("");
  const recRef = useRef<SpeechRecognition | null>(null);

  const start = useCallback(() => {
    const API = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!API) { alert("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)"); return; }

    const rec: SpeechRecognition = new API();
    rec.lang = "ko-KR";
    rec.continuous = false;
    rec.interimResults = true;

    let finalBuf = "";

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interimBuf = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalBuf += t;
        else interimBuf += t;
      }
      setInterim(interimBuf);
    };

    rec.onend = () => {
      setListening(false);
      setInterim("");
      recRef.current = null;
      if (finalBuf.trim()) onResult(finalBuf.trim());
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error !== "aborted") console.error("STT error:", e.error);
      setListening(false);
      setInterim("");
      recRef.current = null;
    };

    recRef.current = rec;
    rec.start();
    setListening(true);
    finalBuf = "";
  }, [onResult]);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  return { listening, interim, toggle };
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function TaskManagerView({
  rosMessages,
  fmsTasks,
  emitFmsDispatch,
  emitFmsCancel,
  robotStatuses,
  tmAlerts,
  ackTmAlert,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "ai",
      text: "안녕하세요! FMS AI 어시스턴트입니다 (RAG 활성화).\nMongoDB 데이터를 기반으로 답변합니다.\n\n예) \"현재 어떤 로봇이 이동 중이야?\"\n예) \"tb3_01을 401_7 노드로 물자 공급 보내줘\"\n\n마이크 버튼으로 음성 명령도 가능합니다.",
    },
  ]);
  const [input, setInput]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const chatEndRef  = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (filterStatus === "active")
      return fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status));
    if (filterStatus === "all") return fmsTasks;
    return fmsTasks.filter(t => t.status === filterStatus);
  }, [fmsTasks, filterStatus]);

  // ── 스트리밍 전송 (RAG는 백엔드에서 자동 처리) ───────────────────────────

  const sendText = useCallback(async (text: string, fromStt = false) => {
    if (!text.trim() || loading) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const userMsgId = uid();
    const aiMsgId   = uid();
    const startMs   = Date.now();

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: "user", text, fromStt },
      { id: aiMsgId, role: "ai", text: "", streaming: true, tokenCount: 0 },
    ]);
    setLoading(true);

    let accumulated = "";
    let tokenCount  = 0;

    try {
      const res = await fetch(`${BACKEND_URL}/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // RAG 컨텍스트는 백엔드 RagService가 자동으로 삽입
        body: JSON.stringify({ prompt: text, systemPrompt: TASK_SYSTEM_PROMPT }),
        signal: ctrl.signal,
      });

      if (!res.body) throw new Error("No stream body");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.token) {
              accumulated += ev.token;
              tokenCount++;
              const snap    = accumulated;
              const cnt     = tokenCount;
              const elapsed = Date.now() - startMs;
              setMessages(prev => prev.map(m =>
                m.id === aiMsgId
                  ? { ...m, text: snap, tokenCount: cnt, elapsedMs: elapsed, tps: Math.round(cnt / (elapsed / 1000)) }
                  : m,
              ));
            }
          } catch {}
        }
      }

      // 스트리밍 완료 → JSON 파싱 시도
      const elapsed = Date.now() - startMs;
      const tps     = Math.round(tokenCount / (elapsed / 1000));

      let parsed: ParsedTask | undefined;
      let displayText = accumulated;

      const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0]);
          if (obj.isTask === true) {
            parsed = {
              type: obj.type, targetNode: obj.targetNode,
              preferredRobotId: obj.preferredRobotId,
              priority: obj.priority, explanation: obj.explanation,
            };
            displayText = obj.explanation ?? "태스크를 파싱했습니다.";
          } else if (obj.isTask === false) {
            displayText = obj.answer ?? accumulated;
          }
        } catch {}
      }

      setMessages(prev => prev.map(m =>
        m.id === aiMsgId
          ? { ...m, text: displayText, streaming: false, tokenCount, elapsedMs: elapsed, tps, parsed }
          : m,
      ));
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId
          ? { ...m, text: "AI 연결 실패. Ollama 서버를 확인해주세요.", streaming: false }
          : m,
      ));
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendText(text, false);
  }, [input, sendText]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.streaming) return prev.map(m => m.id === last.id ? { ...m, streaming: false } : m);
      return prev;
    });
  }, []);

  const confirmTask = useCallback((msgId: string, parsed: ParsedTask) => {
    emitFmsDispatch({ type: parsed.type, targetNode: parsed.targetNode, priority: parsed.priority, preferredRobotId: parsed.preferredRobotId ?? undefined });
    setMessages(prev => [
      ...prev.map(m => m.id === msgId ? { ...m, dismissed: true } : m),
      { id: uid(), role: "ai", text: `디스패치 완료\n${parsed.type} → ${parsed.targetNode}${parsed.preferredRobotId ? " / " + parsed.preferredRobotId : " / 자동배정"}` },
    ]);
  }, [emitFmsDispatch]);

  const dismissTask = useCallback((msgId: string) => {
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, dismissed: true } : m));
  }, []);

  // ── STT: 음성 인식 결과 → 즉시 AI 전송 ──────────────────────────────────

  const handleSttResult = useCallback((text: string) => {
    // 인식된 텍스트를 input에 표시 후 바로 전송
    setInput(text);
    // 약간의 딜레이 후 전송 (사용자가 텍스트를 볼 수 있게)
    setTimeout(() => {
      setInput("");
      sendText(text, true);
    }, 400);
  }, [sendText]);

  const { listening, interim, toggle: toggleMic } = useMic(handleSttResult);

  const onlineCount = ROBOTS.filter(r => isOnline(rosMessages, r.id)).length;
  const activeCount = fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status)).length;

  return (
    <div className="flex flex-col h-full bg-transparent overflow-hidden">

      {/* ── 상단 통계바 ─────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center justify-between px-6 py-3 bg-white/[0.02] border-b border-white/[0.05]">
        <div className="flex items-center gap-8">
          <Stat label="Fleet Online" value={`${onlineCount}/${ROBOTS.length}`} />
          <Stat label="Active Tasks" value={String(activeCount)} />
          <Stat label="Total Tasks"  value={String(fmsTasks.length)} />
        </div>
        <div className="flex items-center gap-3">
          {/* RAG 배지 */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-violet-500/20 bg-violet-500/5">
            <div className="w-1 h-1 rounded-full bg-violet-400" />
            <span className="text-[9px] font-bold tracking-widest text-violet-400/80 uppercase">RAG · MongoDB</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${loading ? "border-amber-500/20 bg-amber-500/5" : "border-emerald-500/20 bg-emerald-500/5"}`}>
            <div className={`w-1 h-1 rounded-full ${loading ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
            <span className={`text-[9px] font-bold tracking-widest uppercase ${loading ? "text-amber-400/80" : "text-emerald-400/80"}`}>
              {loading ? "Generating..." : "EXAONE Ready"}
            </span>
          </div>
        </div>
      </div>

      {/* ── 본문 3단 레이아웃 ────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── 왼쪽: AI 채팅 패널 ────────────────────────────────────────── */}
        <aside className="w-80 flex-none flex flex-col border-r border-white/[0.05] bg-white/[0.01]">
          <div className="flex-none px-5 py-4 border-b border-white/[0.05]">
            <span className="sub-label">AI Command Interface</span>
            <div className="flex items-center justify-between mt-0.5">
              <h2 className="text-sm font-semibold text-white/80 tracking-wide">EXAONE + RAG</h2>
              <span className="text-[9px] text-violet-400/60 tracking-wide">DB 실시간 연동</span>
            </div>
          </div>

          {/* 채팅 히스토리 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map(msg => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                onConfirm={() => msg.parsed && confirmTask(msg.id, msg.parsed)}
                onDismiss={() => dismissTask(msg.id)}
              />
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* 입력 영역 */}
          <div className="flex-none p-4 border-t border-white/[0.05] space-y-2">
            {/* STT 인식 중 표시 */}
            {listening && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
                <div className="flex items-end gap-[2px]">
                  {[0, 0.15, 0.3].map((d, i) => (
                    <div key={i} className="w-0.5 h-3 bg-orange-400 rounded animate-pulse" style={{ animationDelay: `${d}s` }} />
                  ))}
                </div>
                <span className="text-[10px] text-orange-300 font-medium flex-1">
                  {interim || "듣는 중..."}
                </span>
              </div>
            )}

            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                placeholder={listening ? "음성 인식 중..." : "명령이나 질문 입력... (Enter 전송)"}
                disabled={listening}
                className="flex-1 bg-black/40 border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white/80 placeholder:text-white/15 focus:outline-none focus:border-white/20 resize-none disabled:opacity-40"
              />

              {/* 마이크 버튼 */}
              <button
                onClick={toggleMic}
                disabled={loading}
                title={listening ? "음성 인식 중지" : "음성 명령 시작"}
                className={`flex-none w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
                  listening
                    ? "bg-orange-500/30 border-orange-500/50 text-orange-300 animate-pulse"
                    : "bg-white/[0.05] border-white/[0.08] text-white/40 hover:text-orange-300 hover:border-orange-500/30"
                } disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                <MicIcon className="w-4 h-4" />
              </button>

              {/* 전송 / 중지 버튼 */}
              {loading ? (
                <button onClick={stopStream} className="flex-none px-3 py-2 rounded-xl bg-rose-600/30 border border-rose-500/30 text-rose-300 text-xs font-semibold hover:bg-rose-600/50 transition-all">
                  중지
                </button>
              ) : (
                <button onClick={sendMessage} disabled={!input.trim() || listening} className="flex-none px-3 py-2 rounded-xl bg-sky-600/30 border border-sky-500/30 text-sky-300 text-xs font-semibold hover:bg-sky-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                  전송
                </button>
              )}
            </div>
            <p className="text-[10px] text-white/15 tracking-wide">Shift+Enter 줄바꿈 · 🎙 음성으로도 명령 가능</p>
          </div>
        </aside>

        {/* ── 중앙: 태스크 보드 ──────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-none flex items-center gap-3 px-6 py-3 border-b border-white/[0.05]">
            <span className="sub-label !mb-0 mr-2">Filter</span>
            {["active", "all", "PENDING", "RUNNING", "COMPLETED", "FAILED"].map(tab => (
              <button key={tab} onClick={() => setFilterStatus(tab)}
                className={`px-3 py-1 text-[10px] font-semibold tracking-wide rounded-lg border transition-all ${
                  filterStatus === tab ? "bg-white/10 border-white/20 text-white" : "border-white/[0.05] text-white/25 hover:text-white/50"
                }`}
              >{tab}</button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="text-4xl mb-4 opacity-10">◻</div>
                <p className="text-sm text-white/15 tracking-wide">No tasks found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map(task => (
                  <TaskCard key={task._id} task={task} onCancel={() => emitFmsCancel(task._id)} />
                ))}
              </div>
            )}
          </div>
        </main>

        {/* ── 오른쪽: 플릿 상태 ──────────────────────────────────────────── */}
        <aside className="w-64 flex-none flex flex-col border-l border-white/[0.05] bg-white/[0.01]">
          <div className="flex-none px-5 py-4 border-b border-white/[0.05]">
            <span className="sub-label">Fleet Roster</span>
            <h2 className="text-sm font-semibold text-white/80 tracking-wide mt-0.5">
              {onlineCount} / {ROBOTS.length} Online
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {ROBOTS.map(r => (
              <RobotCard
                key={r.id} robot={r}
                online={isOnline(rosMessages, r.id)}
                status={robotStatuses[r.id]}
                task={fmsTasks.find(t => t.assignedRobotId === r.id && ["ASSIGNED", "RUNNING"].includes(t.status))}
                rosMessages={rosMessages}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-white/20 font-semibold tracking-widest uppercase">{label}</div>
      <div className="text-sm font-semibold text-white/80 mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function ChatBubble({ msg, onConfirm, onDismiss }: { msg: ChatMessage; onConfirm: () => void; onDismiss: () => void }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {/* 음성 입력 라벨 */}
      {isUser && msg.fromStt && (
        <div className="flex items-center gap-1 mb-0.5 px-1">
          <MicIcon className="w-2.5 h-2.5 text-orange-400/60" />
          <span className="text-[9px] text-orange-400/50 tracking-wide">음성 입력</span>
        </div>
      )}

      {/* 말풍선 */}
      <div className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
        isUser
          ? `bg-sky-600/20 border text-sky-100 ${msg.fromStt ? "border-orange-500/30" : "border-sky-500/20"}`
          : "bg-white/[0.04] border border-white/[0.07] text-white/75"
      }`}>
        {msg.text}
        {msg.streaming && <span className="inline-block w-1.5 h-3.5 bg-white/50 ml-0.5 animate-pulse align-middle" />}
      </div>

      {/* 속도 정보 */}
      {!isUser && !msg.streaming && msg.elapsedMs !== undefined && (msg.tokenCount ?? 0) > 0 && (
        <div className="flex items-center gap-2 mt-1 px-1">
          <span className="text-[9px] text-white/20 font-mono tabular-nums">
            {msg.tokenCount} tok · {((msg.elapsedMs ?? 0) / 1000).toFixed(1)}s · {msg.tps ?? 0} t/s
          </span>
          <SpeedBar tps={msg.tps ?? 0} />
        </div>
      )}

      {/* 태스크 확인 카드 */}
      {!isUser && msg.parsed && !msg.dismissed && (
        <div className="mt-2 w-full max-w-[92%] p-3 bg-white/[0.03] border border-white/[0.08] rounded-xl">
          <div className="space-y-1.5 mb-3">
            <MetaRow label="유형"     value={msg.parsed.type} accent />
            <MetaRow label="목적지"   value={msg.parsed.targetNode} />
            <MetaRow label="로봇"     value={msg.parsed.preferredRobotId ?? "자동 배정"} />
            <MetaRow label="우선순위" value={`P${msg.parsed.priority}`} />
          </div>
          <div className="flex gap-2">
            <button onClick={onConfirm} className="flex-1 py-1.5 rounded-lg bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold tracking-wide hover:bg-emerald-600/50 transition-all">
              확인 DISPATCH
            </button>
            <button onClick={onDismiss} className="px-3 py-1.5 rounded-lg border border-white/[0.06] text-white/25 text-[10px] hover:text-white/50 transition-all">
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SpeedBar({ tps }: { tps: number }) {
  const pct   = Math.min(100, (tps / 20) * 100);
  const color = tps < 3 ? "bg-rose-500" : tps < 8 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="w-12 h-1 bg-white/[0.05] rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MetaRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between text-[10px]">
      <span className="text-white/30">{label}</span>
      <span className={accent ? "text-white/90 font-bold" : "text-white/60"}>{value}</span>
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

function TaskCard({ task, onCancel }: { task: FmsTask; onCancel: () => void }) {
  const colorClass = TASK_COLORS[task.type] ?? "bg-white/5 border-white/10 text-white/50";
  const dotClass   = STATUS_DOT[task.status] ?? "bg-white/20";
  const elapsed    = task.startedAt ? Math.floor((Date.now() - new Date(task.startedAt).getTime()) / 1000) : null;

  return (
    <div className="glass-card !bg-white/[0.02] border-white/[0.06] p-4 hover:border-white/10 transition-all group">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-1.5 h-1.5 rounded-full flex-none ${dotClass}`} />
          <span className={`text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border ${colorClass}`}>{task.type}</span>
          <span className="text-xs text-white/40 font-mono">→ {task.targetNode}</span>
        </div>
        {["PENDING", "ASSIGNED", "RUNNING"].includes(task.status) && (
          <button onClick={onCancel} className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-rose-400 text-sm transition-all">✕</button>
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-white/25">
        <div className="flex items-center gap-3">
          <span className={`font-semibold tracking-wide ${
            task.status === "RUNNING" ? "text-emerald-400" :
            task.status === "ASSIGNED" ? "text-sky-400" :
            task.status === "FAILED" ? "text-rose-400" : "text-amber-400"
          }`}>{task.status}</span>
          {task.assignedRobotId && <span className="text-white/30">@ {task.assignedRobotId}</span>}
        </div>
        <div className="flex items-center gap-3">
          {elapsed !== null && <span className="font-mono">{elapsed}s</span>}
          <span>P{task.priority}</span>
          <span>{new Date(task.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>
      {task.waitReason && <div className="mt-2 text-[10px] text-amber-400/60 italic">{task.waitReason}</div>}
    </div>
  );
}

function statusDot(online: boolean, status?: string): string {
  if (!online) return "bg-slate-500";
  switch (status) {
    case "IDLE":     return "bg-emerald-400";
    case "MOVING":
    case "WORKING":
    case "CHARGING": return "bg-amber-400 animate-pulse";
    case "ERROR":    return "bg-rose-400 animate-pulse";
    case "OFFLINE":  return "bg-slate-500";
    default:         return "bg-emerald-400";
  }
}

function statusLabel(online: boolean, status?: string): string {
  if (!online) return "OFFLINE";
  return status ?? "IDLE";
}

function statusTextColor(online: boolean, status?: string): string {
  if (!online) return "text-slate-500";
  switch (status) {
    case "IDLE":     return "text-emerald-400/70";
    case "MOVING":
    case "WORKING":
    case "CHARGING": return "text-amber-400/70";
    case "ERROR":    return "text-rose-400/70";
    default:         return "text-white/20";
  }
}

function RobotCard({
  robot, online, status, task, rosMessages,
}: { robot: (typeof ROBOTS)[number]; online: boolean; status?: string; task?: FmsTask; rosMessages: Record<string, RosMessage> }) {
  const bat    = (rosMessages[`/${robot.id}/battery_state`]?.data as any)?.percentage;
  const batPct = bat != null ? Math.round(bat > 1 ? bat : bat * 100) : null;
  const dot    = statusDot(online, status);
  const label  = statusLabel(online, status);
  const txtCol = statusTextColor(online, status);

  return (
    <div className={`rounded-xl border p-3 transition-all duration-500 ${online ? "bg-white/[0.03] border-white/[0.08]" : "bg-transparent border-white/[0.03] opacity-40"}`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-semibold text-white/70 tracking-wide">{robot.label}</div>
          <div className="text-[10px] text-white/20 tracking-widest">DOM {robot.domain}</div>
        </div>
        <div className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      {online ? (
        <div className="space-y-2">
          {batPct !== null && (
            <div>
              <div className="flex justify-between text-[10px] text-white/30 mb-1">
                <span>POWER</span>
                <span className={batPct < 20 ? "text-rose-400" : ""}>{batPct}%</span>
              </div>
              <div className="h-0.5 bg-white/[0.05] rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${batPct < 20 ? "bg-rose-500" : "bg-emerald-500"}`} style={{ width: `${batPct}%` }} />
              </div>
            </div>
          )}
          {task
            ? <div className="text-[10px] px-2 py-1 bg-sky-500/10 border border-sky-500/20 rounded-lg text-sky-300">{task.type} → {task.targetNode}</div>
            : <div className={`text-[10px] italic font-mono ${txtCol}`}>{label}</div>}
        </div>
      ) : <div className="text-[10px] text-slate-500 italic font-mono">OFFLINE</div>}
    </div>
  );
}
