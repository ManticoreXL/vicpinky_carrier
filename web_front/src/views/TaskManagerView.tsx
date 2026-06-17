import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Socket } from "socket.io-client";
import type { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskManagerAlert, RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";

// ── 상수 ──────────────────────────────────────────────────────────────────────

const ROBOTS = [
  { id: "vicpinky", domain: 40, type: "carrier" },
  { id: "tb3_01",   domain: 41, type: "tb3" },
  { id: "tb3_02",   domain: 42, type: "tb3" },
  { id: "tb3_03",   domain: 43, type: "tb3" },
  { id: "tb3_04",   domain: 44, type: "tb3" },
  { id: "omx",      domain: 45, type: "arm" },
] as const;

const TASK_COLORS: Record<string, string> = {
  SUPPLY:  "bg-sky-500/10 border-sky-500/30 text-sky-300",
  PROCESS: "bg-violet-500/10 border-violet-500/30 text-violet-300",
  CHARGE:  "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  MOVE:    "bg-white/5 border-white/10 text-white/50",
};

const STATUS_DOT: Record<string, string> = {
  PENDING:   "bg-amber-400",
  ASSIGNED:  "bg-sky-400",
  RUNNING:   "bg-emerald-400 animate-pulse",
  COMPLETED: "bg-white/30",
  FAILED:    "bg-rose-400",
};

const ONLINE_MS = 5000;


// ── 타입 ──────────────────────────────────────────────────────────────────────

interface AgentAction {
  tool:   string;
  args:   Record<string, unknown>;
  result: unknown;
}

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  loading?: boolean;
  actions?: AgentAction[];
  error?: boolean;
  fromStt?: boolean;
}

interface TopoNode { node_id: string; x: number; y: number; type: string; }

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  socket: Socket | null;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsCancel: (taskId: string) => void;
  robotStatuses: Record<string, string>;
  tmAlerts: TaskManagerAlert[];
  ackTmAlert: (alertId: string) => void;
  robots: RobotInfo[];
  onSelectRobotInFleet: (robotId: string) => void;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
  const topic = robotId === "omx" ? `/${robotId}/joint_states` : `/${robotId}/odom`;
  const msg = rosMessages[topic];
  return !!msg && Date.now() - msg.timestamp < ONLINE_MS;
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function statusDot(online: boolean, status?: string): string {
  if (!online) return "bg-slate-600";
  switch (status) {
    case "IDLE":                      return "bg-emerald-400";
    case "MOVING": case "WORKING":
    case "CHARGING":                  return "bg-amber-400 animate-pulse";
    case "ERROR":                     return "bg-rose-500 animate-pulse";
    default:                          return "bg-emerald-400";
  }
}

function statusLabel(online: boolean, status?: string): string {
  return online ? (status ?? "IDLE") : "OFFLINE";
}

function statusColor(online: boolean, status?: string): string {
  if (!online) return "text-slate-500";
  switch (status) {
    case "IDLE":                      return "text-emerald-400";
    case "MOVING": case "WORKING":
    case "CHARGING":                  return "text-amber-400";
    case "ERROR":                     return "text-rose-400";
    default:                          return "text-emerald-400";
  }
}

function computeNearest(x: number, y: number, nodes: TopoNode[]): string | null {
  if (!nodes.length) return null;
  let best = nodes[0], bestDist = Math.hypot(best.x - x, best.y - y);
  for (const n of nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best.node_id;
}

// ── STT 훅 ────────────────────────────────────────────────────────────────────

function useMic(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim]     = useState("");
  const recRef = useRef<SpeechRecognition | null>(null);

  const start = useCallback(() => {
    const API = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!API) { alert("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)"); return; }
    const rec: SpeechRecognition = new API();
    rec.lang = "ko-KR"; rec.continuous = false; rec.interimResults = true;
    let finalBuf = "";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interimBuf = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalBuf += e.results[i][0].transcript;
        else interimBuf += e.results[i][0].transcript;
      }
      setInterim(interimBuf);
    };
    rec.onend = () => { setListening(false); setInterim(""); recRef.current = null; if (finalBuf.trim()) onResult(finalBuf.trim()); };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => { if (e.error !== "aborted") console.error("STT:", e.error); setListening(false); setInterim(""); recRef.current = null; };
    recRef.current = rec; rec.start(); setListening(true); finalBuf = "";
  }, [onResult]);

  const stop   = useCallback(() => { recRef.current?.stop(); }, []);
  const toggle = useCallback(() => { if (listening) stop(); else start(); }, [listening, start, stop]);
  return { listening, interim, toggle };
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function TaskManagerView({
  rosMessages, fmsTasks, emitFmsDispatch, emitFmsCancel,
  robotStatuses, tmAlerts, ackTmAlert, robots, onSelectRobotInFleet,
}: Props) {

  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: uid(), role: "ai",
    text: "안녕하세요! FMS AI 어시스턴트입니다.\nMongoDB 실시간 RAG로 답변합니다.\n\n예) \"현재 어떤 로봇이 이동 중이야?\"\n예) \"tb3_01을 노드로 보내줘\"\n\n🎙 마이크 버튼으로 음성 명령도 가능합니다.",
  }]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [robotSearch, setRobotSearch]   = useState("");
  const chatEndRef  = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [topoNodes, setTopoNodes] = useState<TopoNode[]>([]);
  const chargerNodes = useMemo(() => topoNodes.filter(n => n.type === "charger").map(n => n.node_id), [topoNodes]);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/map/assignments`)
      .then(r => r.json())
      .then((asgn: Record<string, string>) => {
        const mapId = Object.values(asgn)[0];
        if (!mapId) return;
        fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${mapId}`)
          .then(r => r.json()).then(setTopoNodes).catch(() => {});
      }).catch(() => {});
  }, []);

  const getNearestNode = useCallback((x: number, y: number) => computeNearest(x, y, topoNodes), [topoNodes]);

  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 2000); return () => clearInterval(id); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const visibleRobots = useMemo(() => {
    if (!robotSearch.trim()) return ROBOTS;
    const q = robotSearch.toLowerCase();
    return ROBOTS.filter(r => r.id.toLowerCase().includes(q) || String(r.domain).includes(q));
  }, [robotSearch]);

  const filtered = useMemo(() => {
    if (filterStatus === "active") return fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status));
    if (filterStatus === "all") return fmsTasks;
    return fmsTasks.filter(t => t.status === filterStatus);
  }, [fmsTasks, filterStatus]);

  const handleCharge = useCallback((robotId: string) => {
    emitFmsDispatch({ type: "CHARGE", targetNode: chargerNodes[0] ?? "충전소", preferredRobotId: robotId, priority: 3 });
  }, [chargerNodes, emitFmsDispatch]);

  // ── AI 에이전트 호출 (/ai/agent — 자동 디스패치) ──────────────────────────

  const sendText = useCallback(async (text: string, fromStt = false) => {
    if (!text.trim() || loading) return;
    const userMsgId = uid(), aiMsgId = uid();
    setMessages(prev => [...prev,
      { id: userMsgId, role: "user", text, fromStt },
      { id: aiMsgId,   role: "ai",   text: "", loading: true },
    ]);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/ai/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
      const data = await res.json() as { reply: string; actions: AgentAction[] };
      setMessages(prev => prev.map(m => m.id === aiMsgId
        ? { ...m, text: data.reply, actions: data.actions, loading: false } : m));
    } catch (err: any) {
      setMessages(prev => prev.map(m => m.id === aiMsgId
        ? { ...m, text: err.message ?? "AI 연결 실패", loading: false, error: true } : m));
    } finally { setLoading(false); }
  }, [loading]);

  const sendMessage = useCallback(() => { const t = input.trim(); if (!t) return; setInput(""); sendText(t); }, [input, sendText]);
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  const handleSttResult = useCallback((text: string) => {
    setInput(text);
    setTimeout(() => { setInput(""); sendText(text, true); }, 400);
  }, [sendText]);

  const { listening, interim, toggle: toggleMic } = useMic(handleSttResult);

  const onlineCount = ROBOTS.filter(r => isOnline(rosMessages, r.id)).length;
  const activeCount = fmsTasks.filter(t => ["PENDING", "ASSIGNED", "RUNNING"].includes(t.status)).length;

  return (
    <div className="flex flex-col h-full bg-transparent overflow-hidden">

      {/* ── 상단 통계바 ─────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center justify-between px-6 py-2.5 bg-white/[0.02] border-b border-white/[0.05]">
        <div className="flex items-center gap-8">
          <Stat label="Fleet Online" value={`${onlineCount}/${ROBOTS.length}`} />
          <Stat label="Active Tasks" value={String(activeCount)} />
          <Stat label="Total"        value={String(fmsTasks.length)} />
          {tmAlerts.length > 0 && <Stat label="Alerts" value={String(tmAlerts.length)} warn />}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-violet-500/20 bg-violet-500/5">
            <div className="w-1 h-1 rounded-full bg-violet-400" />
            <span className="text-[9px] font-bold tracking-widest text-violet-400/80 uppercase">RAG · MongoDB</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${loading ? "border-amber-500/20 bg-amber-500/5" : "border-emerald-500/20 bg-emerald-500/5"}`}>
            <div className={`w-1 h-1 rounded-full ${loading ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
            <span className={`text-[9px] font-bold tracking-widest uppercase ${loading ? "text-amber-400/80" : "text-emerald-400/80"}`}>
              {loading ? "Generating..." : "AI Ready"}
            </span>
          </div>
        </div>
      </div>

      {/* ── 3컬럼 본문 ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ══ 컬럼 1: Fleet AI ════════════════════════════════════════════ */}
        <aside className="w-80 flex-none flex flex-col border-r border-white/[0.05] bg-white/[0.01]">
          <div className="flex-none px-5 py-3.5 border-b border-white/[0.05]">
            <span className="sub-label">AI Command Interface</span>
            <div className="flex items-center justify-between mt-0.5">
              <h2 className="text-sm font-semibold text-white/80 tracking-wide">FLEET AI</h2>
              <span className="text-[9px] text-violet-400/60 tracking-wide">Qwen + EXAONE</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map(msg => (
              <ChatBubble key={msg.id} msg={msg} />
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="flex-none p-4 border-t border-white/[0.05] space-y-2">
            {listening && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
                <div className="flex items-end gap-[2px]">
                  {[0, 0.15, 0.3].map((d, i) => (
                    <div key={i} className="w-0.5 h-3 bg-orange-400 rounded animate-pulse" style={{ animationDelay: `${d}s` }} />
                  ))}
                </div>
                <span className="text-[10px] text-orange-300 font-medium flex-1">{interim || "듣는 중..."}</span>
              </div>
            )}
            <div className="flex gap-2 items-end">
              <textarea ref={textareaRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown} rows={2}
                placeholder={listening ? "음성 인식 중..." : "명령이나 질문 입력... (Enter 전송)"}
                disabled={listening}
                className="flex-1 bg-black/40 border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white/80 placeholder:text-white/15 focus:outline-none focus:border-white/20 resize-none disabled:opacity-40"
              />
              <button onClick={toggleMic} disabled={loading}
                className={`flex-none w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
                  listening ? "bg-orange-500/30 border-orange-500/50 text-orange-300 animate-pulse"
                            : "bg-white/[0.05] border-white/[0.08] text-white/40 hover:text-orange-300 hover:border-orange-500/30"
                } disabled:opacity-30 disabled:cursor-not-allowed`}>
                <MicIcon className="w-4 h-4" />
              </button>
              <button onClick={sendMessage} disabled={!input.trim() || listening || loading}
                className="flex-none px-3 py-2 rounded-xl bg-sky-600/30 border border-sky-500/30 text-sky-300 text-xs font-semibold hover:bg-sky-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                {loading ? "..." : "전송"}
              </button>
            </div>
            <p className="text-[10px] text-white/15">Shift+Enter 줄바꿈 · 🎙 음성 명령 가능</p>
          </div>
        </aside>

        {/* ══ 컬럼 2: Fleet Monitor ════════════════════════════════════════ */}
        <div className="w-80 flex-none flex flex-col border-r border-white/[0.05] bg-black/10">
          {/* 헤더 + 검색 */}
          <div className="flex-none px-4 pt-3.5 pb-3 border-b border-white/[0.05]">
            <div className="flex items-center justify-between mb-2.5">
              <div>
                <span className="sub-label">Fleet Monitor</span>
                <div className="text-xs font-semibold text-white/70 tracking-wide mt-0.5">
                  {onlineCount} / {ROBOTS.length} Online
                </div>
              </div>
            </div>
            <div className="relative">
              <input
                value={robotSearch}
                onChange={e => setRobotSearch(e.target.value)}
                placeholder="로봇 검색 (id · domain)..."
                className="w-full bg-black/40 border border-white/[0.08] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white/60 placeholder:text-white/15 focus:outline-none focus:border-white/20"
              />
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>

          {/* 로봇 카드 목록 */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {visibleRobots.length === 0 ? (
              <div className="flex items-center justify-center h-full text-white/15 text-xs">검색 결과 없음</div>
            ) : visibleRobots.map(r => {
              const online  = isOnline(rosMessages, r.id);
              const status  = robotStatuses[r.id];
              const task    = fmsTasks.find(t => t.assignedRobotId === r.id && ["ASSIGNED", "RUNNING"].includes(t.status));
              const dbInfo  = robots.find(ri => ri.robot_id === r.id);
              const batRos  = (rosMessages[`/${r.id}/battery_state`]?.data as any)?.percentage;
              const bat     = batRos ?? dbInfo?.battery;
              const batPct  = bat != null ? Math.round(bat > 1 ? bat : bat * 100) : null;
              const amclPos = (rosMessages[`/${r.id}/amcl_pose`]?.data as any)?.pose?.pose?.position;
              const odomPos = (rosMessages[`/${r.id}/odom`]?.data as any)?.pose?.pose?.position;
              const posX    = amclPos?.x ?? odomPos?.x ?? dbInfo?.pose_x;
              const posY    = amclPos?.y ?? odomPos?.y ?? dbInfo?.pose_y;
              const nodeId  = (posX != null && posY != null) ? getNearestNode(posX, posY) : (dbInfo?.location ?? null);

              return (
                <RobotMonitorCard
                  key={r.id} robot={r} online={online} status={status}
                  task={task} batPct={batPct} nodeId={nodeId}
                  onCharge={() => handleCharge(r.id)}
                  onClick={() => onSelectRobotInFleet(r.id)}
                />
              );
            })}
          </div>
        </div>

        {/* ══ 컬럼 3: Task 목록 ════════════════════════════════════════════ */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-none px-5 pt-3.5 pb-3 border-b border-white/[0.05]">
            <span className="sub-label">Task Board</span>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {["active", "all", "PENDING", "RUNNING", "COMPLETED", "FAILED"].map(tab => (
                <button key={tab} onClick={() => setFilterStatus(tab)}
                  className={`px-3 py-1 text-[10px] font-semibold tracking-wide rounded-lg border transition-all ${
                    filterStatus === tab ? "bg-white/10 border-white/20 text-white" : "border-white/[0.05] text-white/25 hover:text-white/50"
                  }`}>{tab}</button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
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

      </div>
    </div>
  );
}

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────────

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-white/20 font-semibold tracking-widest uppercase">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 tabular-nums ${warn ? "text-rose-400" : "text-white/80"}`}>{value}</div>
    </div>
  );
}

// 가로로 가득 차는 로봇 카드 (Fleet Monitor 전용)
function RobotMonitorCard({
  robot, online, status, task, batPct, nodeId, onCharge, onClick,
}: {
  robot: (typeof ROBOTS)[number];
  online: boolean;
  status?: string;
  task?: FmsTask;
  batPct: number | null;
  nodeId: string | null;
  onCharge: () => void;
  onClick: () => void;
}) {
  const isLowBat = batPct !== null && batPct < 25;
  const dot      = statusDot(online, status);
  const lbl      = statusLabel(online, status);
  const txtCol   = statusColor(online, status);

  return (
    <div
      onClick={onClick}
      title="클릭 → Fleet 탭에서 해당 로봇 확인"
      className={`group w-full cursor-pointer rounded-xl border px-4 py-3 transition-all duration-300 select-none ${
        online
          ? "bg-white/[0.04] border-white/[0.10] hover:bg-white/[0.07] hover:border-white/20"
          : "bg-transparent border-white/[0.04] opacity-55 hover:opacity-75 hover:border-white/[0.09]"
      }`}
    >
      {/* 행 1: robot_id + 상태 도트 + 상태 텍스트 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-bold font-mono text-white/90 tracking-wide">{robot.id}</span>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${dot}`} />
          <span className={`text-[10px] font-bold tracking-widest ${txtCol}`}>{lbl}</span>
        </div>
      </div>

      {/* 행 2: 노드 위치 + domain */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-white/35 font-mono truncate max-w-[70%]" title={nodeId ?? ""}>
          {nodeId ? `📍 ${nodeId}` : <span className="text-white/15 italic">위치 없음</span>}
        </span>
        <span className="text-[9px] text-white/15 flex-none">DOM {robot.domain}</span>
      </div>

      {/* 행 3: 현재 태스크 */}
      {task ? (
        <div className={`text-[10px] px-2 py-0.5 rounded border mb-2 truncate ${TASK_COLORS[task.type] ?? "bg-white/5 border-white/10 text-white/50"}`}
          title={`${task.type} → ${task.targetNode}`}>
          {task.type} → {task.targetNode}
        </div>
      ) : (
        <div className="mb-2 h-5" />
      )}

      {/* 행 4: 배터리 바 + 퍼센트 + 충전 버튼 */}
      <div className="flex items-center gap-2">
        {batPct !== null ? (
          <>
            <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${batPct < 20 ? "bg-rose-500 animate-pulse" : batPct < 50 ? "bg-amber-400" : "bg-emerald-500"}`}
                style={{ width: `${batPct}%` }}
              />
            </div>
            <span className={`text-[10px] font-mono flex-none w-8 text-right ${isLowBat ? "text-rose-400 font-bold" : "text-white/40"}`}>
              {batPct}%
            </span>
          </>
        ) : (
          <div className="flex-1 h-1.5 bg-white/[0.03] rounded-full" />
        )}
        {online && (
          <button
            onClick={e => { e.stopPropagation(); onCharge(); }}
            title="충전소 이동 태스크 생성"
            className={`flex-none text-[9px] px-2 py-0.5 rounded border transition-all ${
              isLowBat
                ? "bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30"
                : "border-white/[0.07] text-white/20 hover:text-white/55 hover:border-white/15"
            }`}
          >
            ⚡
          </button>
        )}
      </div>

      {/* Fleet 이동 힌트 */}
      <div className="h-3 mt-0.5 flex justify-end items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-[8px] text-white/20">→ Fleet 보기</span>
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  dispatch_task:    "태스크 디스패치",
  cancel_task:      "태스크 취소",
  stop_robot:       "로봇 정지",
  return_home:      "홈 귀환",
  get_robots:       "로봇 상태 조회",
  get_nodes:        "노드 목록 조회",
  get_active_tasks: "활성 태스크 조회",
  lock_node:        "노드 잠금",
};

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {isUser && msg.fromStt && (
        <div className="flex items-center gap-1 mb-0.5 px-1">
          <MicIcon className="w-2.5 h-2.5 text-orange-400/60" />
          <span className="text-[9px] text-orange-400/50">음성 입력</span>
        </div>
      )}
      {!isUser && (
        <span className="text-[10px] text-violet-400/70 font-semibold tracking-widest px-1 mb-0.5">
          FLEET AI {msg.fromStt && "🎙"}
        </span>
      )}
      <div className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
        isUser
          ? `bg-sky-600/20 border text-sky-100 ${msg.fromStt ? "border-orange-500/30" : "border-sky-500/20"}`
          : msg.error
            ? "bg-rose-500/10 border border-rose-500/20 text-rose-300"
            : "bg-white/[0.04] border border-white/[0.07] text-white/75"
      }`}>
        {msg.loading
          ? <span className="flex items-center gap-2 text-white/40">
              <span className="flex gap-0.5">
                {[0, 1, 2].map(i => (
                  <span key={i} className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              처리 중…
            </span>
          : msg.text
        }
      </div>

      {/* 실행된 툴 목록 */}
      {!isUser && msg.actions && msg.actions.length > 0 && (
        <div className="w-full max-w-[92%] mt-1.5 space-y-1">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-[10px] text-violet-400/60 hover:text-violet-400 flex items-center gap-1 px-1 transition-colors"
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
  );
}

function ActionCard({ action }: { action: AgentAction }) {
  const label  = TOOL_LABELS[action.tool] ?? action.tool;
  const result = action.result as any;
  const ok     = result?.ok !== false && !result?.error;
  return (
    <div className={`rounded-xl px-3 py-2 border text-xs ${ok ? "bg-emerald-500/8 border-emerald-500/20" : "bg-rose-500/8 border-rose-500/20"}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={ok ? "text-emerald-400" : "text-rose-400"}>{ok ? "✓" : "✗"}</span>
        <span className={`font-semibold ${ok ? "text-emerald-300" : "text-rose-300"}`}>{label}</span>
      </div>
      <div className="text-white/30 font-mono text-[10px] mb-0.5">
        {Object.entries(action.args).map(([k, v]) => (
          <span key={k} className="mr-2"><span className="text-white/20">{k}:</span> <span className="text-white/45">{String(v)}</span></span>
        ))}
      </div>
      {result?.message && <p className={`mt-0.5 text-[10px] ${ok ? "text-emerald-300/70" : "text-rose-300/70"}`}>{result.message}</p>}
      {result?.error   && <p className="mt-0.5 text-[10px] text-rose-400">{result.error}</p>}
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
          <span className={`font-semibold ${
            task.status === "RUNNING" ? "text-emerald-400" : task.status === "ASSIGNED" ? "text-sky-400" :
            task.status === "FAILED" ? "text-rose-400" : "text-amber-400"
          }`}>{task.status}</span>
          {task.assignedRobotId && <span className="text-white/30 font-mono">@ {task.assignedRobotId}</span>}
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
