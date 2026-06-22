import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Socket } from "socket.io-client";
import type { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskManagerAlert, RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { ROBOTS } from "./taskmanager/constants";
import type { AgentAction, ChatMessage, TopoNode } from "./taskmanager/types";
import { isOnline, uid, computeNearest } from "./taskmanager/helpers";
import { useMic } from "./taskmanager/useMic";
import { Stat, RobotMonitorCard, ChatBubble, TaskCard, RobotTaskGroup, MicIcon } from "./taskmanager/components";

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  socket: Socket | null;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsCancel: (taskId: string) => void;
  emitFmsAutoCharge: (robotId: string) => void;
  emitFmsRegister: (p: FmsDispatchPayload) => void;
  emitFmsRelease: (taskId: string) => void;
  robotStatuses: Record<string, string>;
  tmAlerts: TaskManagerAlert[];
  ackTmAlert: (alertId: string) => void;
  robots: RobotInfo[];
  onSelectRobotInFleet: (robotId: string) => void;
}

// 태스크 생성 폼 상수 (4종)
const TASK_LABELS: Record<TaskType, string> = { SUPPLY: "공급", PROCESS: "구호", CHARGE: "충전", MOVE: "이동" };
const TASK_PRIORITIES: Record<TaskType, number> = { SUPPLY: 1, CHARGE: 1, MOVE: 2, PROCESS: 3 };
const SUPPLY_ITEMS = ["물", "약"] as const;
const SUPPLY_ROBOT_ID = "omx";

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function TaskManagerView({
  rosMessages, fmsTasks, emitFmsDispatch, emitFmsCancel, emitFmsAutoCharge, emitFmsRegister, emitFmsRelease,
  robotStatuses, tmAlerts, ackTmAlert, robots, onSelectRobotInFleet,
}: Props) {

  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: uid(), role: "ai",
    text: "안녕하세요! FMS AI 어시스턴트입니다.\nMongoDB 실시간 RAG로 답변합니다.\n\n예) \"현재 어떤 로봇이 이동 중이야?\"\n예) \"tb3_01을 노드로 보내줘\"\n\n🎙 마이크 버튼으로 음성 명령도 가능합니다.",
  }]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [boardTab, setBoardTab]         = useState<"task" | "robot">("task");
  const [robotSearch, setRobotSearch]   = useState("");
  const chatEndRef  = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [topoNodes, setTopoNodes] = useState<TopoNode[]>([]);

  // ── 태스크 생성(등록/배차) 폼 ────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(true);
  const [form, setForm] = useState({ type: "MOVE" as TaskType, targetNode: "", preferredRobotId: "", supplyItem: "물" as typeof SUPPLY_ITEMS[number] });
  const isSupply = form.type === "SUPPLY";
  // 충전: 사람은 로봇만 고르고 목적지(충전소)는 백엔드가 자동 결정 → autoCharge 경로로 전송
  const isCharge = form.type === "CHARGE";
  const buildPayload = (): FmsDispatchPayload => isSupply
    ? { type: "SUPPLY", targetNode: form.supplyItem, priority: 1, preferredRobotId: SUPPLY_ROBOT_ID }
    : { type: form.type, targetNode: form.targetNode, priority: TASK_PRIORITIES[form.type], preferredRobotId: form.preferredRobotId || undefined };
  const canCreate = isSupply ? !!form.supplyItem : isCharge ? !!form.preferredRobotId : !!form.targetNode;
  const submitCreate = (emit: (p: FmsDispatchPayload) => void) => {
    if (!canCreate) return;
    // 충전은 robotId만 백엔드로 — 충전소 선택/점유 검사/배차는 백엔드가 수행
    if (isCharge) { emitFmsAutoCharge(form.preferredRobotId); return; }
    emit(buildPayload());
    setForm(f => ({ ...f, targetNode: "" }));
  };

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

  // 자동충전 — robotId만 백엔드로 전송. 최근접 충전소 선택/점유 검사/배차는 모두 백엔드가 수행.
  const handleCharge = useCallback((robotId: string) => {
    emitFmsAutoCharge(robotId);
  }, [emitFmsAutoCharge]);

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
      <div className="flex-none flex items-center justify-between px-6 py-2.5 bg-[#FFCE99]/32 border-b border-white/[0.1]">
        <div className="flex items-center gap-8">
          <Stat label="온라인" value={`${onlineCount}/${ROBOTS.length}`} />
          <Stat label="진행 태스크" value={String(activeCount)} />
          <Stat label="전체" value={String(fmsTasks.length)} />
          {tmAlerts.length > 0 && <Stat label="알림" value={String(tmAlerts.length)} warn />}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-violet-500/20 bg-violet-500/5">
            <div className="w-1 h-1 rounded-full bg-violet-400" />
            <span className="text-[9px] font-bold tracking-widest text-violet-600/80 uppercase">RAG · MongoDB</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${loading ? "border-amber-500/20 bg-amber-500/5" : "border-emerald-500/20 bg-emerald-500/5"}`}>
            <div className={`w-1 h-1 rounded-full ${loading ? "bg-amber-400 animate-pulse" : "bg-emerald-400"}`} />
            <span className={`text-[9px] font-bold tracking-widest ${loading ? "text-amber-600/80" : "text-emerald-600/80"}`}>
              {loading ? "생성 중…" : "AI 준비됨"}
            </span>
          </div>
        </div>
      </div>

      {/* ── 3컬럼 본문 ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ══ 컬럼 1: Fleet AI ════════════════════════════════════════════ */}
        <aside className="w-80 flex-none flex flex-col border-r border-white/[0.1] bg-[#FFCE99]/32">
          <div className="flex-none px-5 py-3.5 border-b border-white/[0.1]">
            <span className="sub-label">AI 명령 인터페이스</span>
            <div className="flex items-center justify-between mt-0.5">
              <h2 className="text-sm font-semibold text-white/80 tracking-wide">플릿 AI</h2>
              <span className="text-[9px] text-violet-600/60 tracking-wide">Qwen + EXAONE</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map(msg => (
              <ChatBubble key={msg.id} msg={msg} />
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="flex-none p-4 border-t border-white/[0.1] space-y-2">
            {listening && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
                <div className="flex items-end gap-[2px]">
                  {[0, 0.15, 0.3].map((d, i) => (
                    <div key={i} className="w-0.5 h-3 bg-orange-400 rounded animate-pulse" style={{ animationDelay: `${d}s` }} />
                  ))}
                </div>
                <span className="text-[10px] text-orange-700 font-medium flex-1">{interim || "듣는 중..."}</span>
              </div>
            )}
            <div className="flex gap-2 items-end">
              <textarea ref={textareaRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown} rows={2}
                placeholder={listening ? "음성 인식 중..." : "명령이나 질문 입력... (Enter 전송)"}
                disabled={listening}
                className="flex-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-xl px-3 py-2 text-xs text-white/80 placeholder:text-white/[0.4] focus:outline-none focus:border-white/[0.08] resize-none disabled:opacity-40"
              />
              <button onClick={toggleMic} disabled={loading}
                className={`flex-none w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
                  listening ? "bg-orange-500/30 border-orange-500/50 text-orange-700 animate-pulse"
                            : "bg-[#FFCE99]/32 border-white/[0.1] text-white/[0.6] hover:text-orange-700 hover:border-orange-500/30"
                } disabled:opacity-30 disabled:cursor-not-allowed`}>
                <MicIcon className="w-4 h-4" />
              </button>
              <button onClick={sendMessage} disabled={!input.trim() || listening || loading}
                className="flex-none px-3 py-2 rounded-xl bg-sky-600/30 border border-sky-500/30 text-sky-700 text-xs font-semibold hover:bg-sky-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                {loading ? "..." : "전송"}
              </button>
            </div>
            <p className="text-[10px] text-white/[0.4]">Shift+Enter 줄바꿈 · 🎙 음성 명령 가능</p>
          </div>
        </aside>

        {/* ══ 컬럼 2: Fleet Monitor ════════════════════════════════════════ */}
        <div className="w-80 flex-none flex flex-col border-r border-white/[0.1] bg-[#FFCE99]/32">
          {/* 헤더 + 검색 */}
          <div className="flex-none px-4 pt-3.5 pb-3 border-b border-white/[0.1]">
            <div className="flex items-center justify-between mb-2.5">
              <div>
                <span className="sub-label">로봇 모니터</span>
                <div className="text-xs font-semibold text-white/[0.82] tracking-wide mt-0.5">
                  온라인 {onlineCount} / {ROBOTS.length}
                </div>
              </div>
            </div>
            <div className="relative">
              <input
                value={robotSearch}
                onChange={e => setRobotSearch(e.target.value)}
                placeholder="로봇 검색 (id · domain)..."
                className="w-full bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white/[0.75] placeholder:text-white/[0.4] focus:outline-none focus:border-white/[0.08]"
              />
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/[0.45]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>

          {/* 로봇 카드 목록 */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {visibleRobots.length === 0 ? (
              <div className="flex items-center justify-center h-full text-white/[0.4] text-xs">검색 결과 없음</div>
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

        {/* ══ 컬럼 3: 작업 현황 (태스크별 / 로봇별) ═══════════════════════ */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-none px-5 pt-3.5 pb-3 border-b border-white/[0.1]">
            <div className="flex items-center justify-between">
              <span className="sub-label">작업 현황</span>
              {/* 최상위 보기 전환: 태스크별 / 로봇별 */}
              <div className="flex bg-[#FFCE99]/14 p-0.5 rounded-lg border border-white/[0.1]">
                {([["task", "태스크별"], ["robot", "로봇별"]] as [typeof boardTab, string][]).map(([val, label]) => (
                  <button key={val} onClick={() => setBoardTab(val)}
                    className={`px-3 py-1 text-[10px] font-bold tracking-wide rounded-md transition-all ${
                      boardTab === val ? "bg-white/10 text-white shadow" : "text-white/[0.5] hover:text-white/[0.7]"
                    }`}>{label}</button>
                ))}
              </div>
            </div>

            {/* 태스크별일 때만 상태 필터 노출 */}
            {boardTab === "task" && (
              <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                {([
                  ["active",    "진행 중"],
                  ["all",       "전체"],
                  ["DRAFT",     "등록됨"],
                  ["PENDING",   "대기 중"],
                  ["RUNNING",   "수행 중"],
                  ["COMPLETED", "완료"],
                  ["FAILED",    "실패"],
                ] as [string, string][]).map(([val, label]) => (
                  <button key={val} onClick={() => setFilterStatus(val)}
                    className={`px-3 py-1 text-[10px] font-semibold tracking-wide rounded-lg border transition-all ${
                      filterStatus === val ? "bg-white/10 border-white/[0.08] text-white" : "border-white/[0.1] text-white/[0.5] hover:text-white/[0.68]"
                    }`}>{label}</button>
                ))}
              </div>
            )}
          </div>

          {/* ── 태스크 등록/배차 폼 (4종 → 글로벌 큐) ───────────────────────── */}
          {boardTab === "task" && (
          <div className="flex-none border-b border-white/[0.1] bg-[#FFCE99]/14">
            <button onClick={() => setShowCreate(v => !v)}
              className="w-full flex items-center justify-between px-5 py-2 text-[11px] font-bold tracking-wide text-white/[0.7] hover:text-white/90">
              <span>＋ 태스크 등록 / 배차</span>
              <span className="text-white/[0.45]">{showCreate ? "▾" : "▸"}</span>
            </button>
            {showCreate && (
            <div className="px-5 pb-4 space-y-2.5">
              {/* 유형 4종 (충전은 목적지 없이 로봇만 지정 — 백엔드가 충전소 자동 선택) */}
              <div className="grid grid-cols-4 gap-1">
                {(Object.keys(TASK_LABELS) as TaskType[]).map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, type: t, targetNode: "" }))}
                    className={`py-1 text-[10px] font-bold rounded border transition-all ${form.type === t ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1] hover:text-white/[0.75]"}`}>
                    {TASK_LABELS[t]}
                  </button>
                ))}
              </div>
              {/* 목적지 (공급은 품목) */}
              {isSupply ? (
                <div className="grid grid-cols-2 gap-1">
                  {SUPPLY_ITEMS.map(item => (
                    <button key={item} onClick={() => setForm(f => ({ ...f, supplyItem: item }))}
                      className={`py-1.5 text-xs font-bold rounded border transition-all ${form.supplyItem === item ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.6] border-white/[0.1] hover:text-white/[0.85]"}`}>
                      {item === "물" ? "💧 물" : "💊 약"}
                    </button>
                  ))}
                </div>
              ) : isCharge ? (
                <div className="px-2.5 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-600/10 text-[10px] text-emerald-700 leading-relaxed">
                  ⚡ 목적지 없음 — 선택한 로봇의 최근접·미점유 충전소를 백엔드가 자동 선택합니다.
                </div>
              ) : (
                <select value={form.targetNode} onChange={e => setForm(f => ({ ...f, targetNode: e.target.value }))}
                  className="w-full bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none focus:border-white/[0.2]">
                  <option value="">목적지 노드 선택…</option>
                  {topoNodes.map(n => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.type})</option>)}
                </select>
              )}
              {/* 지정 로봇 (공급은 omx 고정 / 충전은 반드시 1대 지정) */}
              {!isSupply && (
                <select value={form.preferredRobotId} onChange={e => setForm(f => ({ ...f, preferredRobotId: e.target.value }))}
                  className="w-full bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/75 focus:outline-none focus:border-white/[0.2]">
                  <option value="">{isCharge ? "충전할 로봇 선택…" : "자동 배정"}</option>
                  {ROBOTS.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
                </select>
              )}
              {/* 충전: 단일 버튼(로봇만 지정) / 그 외: 등록만(DRAFT) · 즉시 배차 */}
              {isCharge ? (
                <button onClick={() => submitCreate(emitFmsDispatch)} disabled={!canCreate}
                  title="선택한 로봇을 최근접 충전소로 자동 충전 (목적지는 백엔드가 결정)"
                  className="w-full py-2 text-[11px] font-bold rounded-lg border border-emerald-500/50 bg-emerald-600/30 text-emerald-100 hover:bg-emerald-600/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                  {form.preferredRobotId ? `⚡ ${form.preferredRobotId} 충전 보내기` : "충전할 로봇을 선택하세요"}
                </button>
              ) : (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => submitCreate(emitFmsRegister)} disabled={!canCreate}
                  title="글로벌 큐에 등록만 (DRAFT) — 목록에서 '배차'로 할당"
                  className="py-2 text-[11px] font-bold rounded-lg border border-violet-500/50 bg-violet-600/30 text-violet-100 hover:bg-violet-600/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                  등록만
                </button>
                <button onClick={() => submitCreate(emitFmsDispatch)} disabled={!canCreate}
                  className="py-2 text-[11px] font-bold rounded-lg border border-sky-500/50 bg-sky-600/30 text-sky-100 hover:bg-sky-600/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                  {isSupply ? "omx 공급" : "즉시 배차"}
                </button>
              </div>
              )}
            </div>
            )}
          </div>
          )}

          <div className="flex-1 overflow-y-auto p-5">
            {boardTab === "task" ? (
              filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div className="text-4xl mb-4 opacity-10">◻</div>
                  <p className="text-sm text-white/[0.4] tracking-wide">표시할 태스크가 없습니다</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filtered.map(task => (
                    <TaskCard key={task._id} task={task} onCancel={() => emitFmsCancel(task._id)} onRelease={() => emitFmsRelease(task._id)} />
                  ))}
                </div>
              )
            ) : (
              <div className="space-y-4">
                {ROBOTS.map(r => (
                  <RobotTaskGroup
                    key={r.id}
                    robotId={r.id}
                    tasks={fmsTasks}
                    online={isOnline(rosMessages, r.id)}
                    status={robotStatuses[r.id]}
                    onCancel={emitFmsCancel}
                  />
                ))}
              </div>
            )}
          </div>
        </main>

      </div>
    </div>
  );
}
