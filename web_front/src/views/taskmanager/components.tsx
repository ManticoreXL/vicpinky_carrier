import { useState } from "react";
import type { FmsTask } from "../../hooks/useNestSocket";
import { robotStatusKo, taskStatusKo, taskTypeKo } from "../../utils/statusLabel";
import { ROBOTS, TASK_COLORS, STATUS_DOT, TOOL_LABELS } from "./constants";
import { robotVisual } from "./helpers";
import type { AgentAction, ChatMessage } from "./types";

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────────

export function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-white/[0.45] font-semibold tracking-widest uppercase">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 tabular-nums ${warn ? "text-rose-600" : "text-white/80"}`}>{value}</div>
    </div>
  );
}

// 가로로 가득 차는 로봇 카드 (Fleet Monitor 전용)
export function RobotMonitorCard({
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
  const { dot, label: lbl, color: txtCol } = robotVisual(online, status);

  return (
    <div
      onClick={onClick}
      title="클릭 → Fleet 탭에서 해당 로봇 확인"
      className={`group w-full cursor-pointer rounded-xl border px-4 py-3 transition-all duration-300 select-none ${
        online
          ? "bg-[#FFCE99]/32 border-white/[0.12] hover:bg-[#FFCE99]/32 hover:border-white/[0.08]"
          : "bg-transparent border-white/[0.08] opacity-55 hover:opacity-75 hover:border-white/[0.11]"
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
        <span className="text-[10px] text-white/[0.55] font-mono truncate max-w-[70%]" title={nodeId ?? ""}>
          {nodeId ? `📍 ${nodeId}` : <span className="text-white/[0.4] italic">위치 없음</span>}
        </span>
        <span className="text-[9px] text-white/[0.4] flex-none">도메인 {robot.domain}</span>
      </div>

      {/* 행 3: 현재 태스크 */}
      {task ? (
        <div className={`text-[10px] px-2 py-0.5 rounded border mb-2 truncate ${TASK_COLORS[task.type] ?? "bg-[#FFCE99]/32 border-white/[0.12] text-white/[0.68]"}`}
          title={`${taskTypeKo(task.type)} → ${task.targetNode}`}>
          {taskTypeKo(task.type)} → {task.targetNode}
        </div>
      ) : (
        <div className="mb-2 h-5" />
      )}

      {/* 행 4: 배터리 바 + 퍼센트 + 충전 버튼 */}
      <div className="flex items-center gap-2">
        {batPct !== null ? (
          <>
            <div className="flex-1 h-1.5 bg-[#FFCE99]/32 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${batPct < 20 ? "bg-rose-500 animate-pulse" : batPct < 50 ? "bg-amber-400" : "bg-emerald-500"}`}
                style={{ width: `${batPct}%` }}
              />
            </div>
            <span className={`text-[10px] font-mono flex-none w-8 text-right ${isLowBat ? "text-rose-600 font-bold" : "text-white/[0.6]"}`}>
              {batPct}%
            </span>
          </>
        ) : (
          <div className="flex-1 h-1.5 bg-[#FFCE99]/32 rounded-full" />
        )}
        {online && (
          <button
            onClick={e => { e.stopPropagation(); onCharge(); }}
            title="충전소 이동 태스크 생성"
            className={`flex-none text-[9px] px-2 py-0.5 rounded border transition-all ${
              isLowBat
                ? "bg-rose-500/20 border-rose-500/40 text-rose-700 hover:bg-rose-500/30"
                : "border-white/[0.1] text-white/[0.45] hover:text-white/55 hover:border-white/[0.13]"
            }`}
          >
            ⚡
          </button>
        )}
      </div>

      {/* Fleet 이동 힌트 */}
      <div className="h-3 mt-0.5 flex justify-end items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-[8px] text-white/[0.45]">→ Fleet 보기</span>
      </div>
    </div>
  );
}

export function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {isUser && msg.fromStt && (
        <div className="flex items-center gap-1 mb-0.5 px-1">
          <MicIcon className="w-2.5 h-2.5 text-orange-600/60" />
          <span className="text-[9px] text-orange-600/50">음성 입력</span>
        </div>
      )}
      {!isUser && (
        <span className="text-[10px] text-violet-600/70 font-semibold tracking-widest px-1 mb-0.5">
          플릿 AI {msg.fromStt && "🎙"}
        </span>
      )}
      <div className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
        isUser
          ? `bg-sky-500/20 border text-sky-900 ${msg.fromStt ? "border-orange-500/40" : "border-sky-500/40"}`
          : msg.error
            ? "bg-rose-500/10 border border-rose-500/20 text-rose-700"
            : "bg-[#FFCE99]/32 border border-white/[0.1] text-white/75"
      }`}>
        {msg.loading
          ? <span className="flex items-center gap-2 text-white/[0.6]">
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
            className="text-[10px] text-violet-600/60 hover:text-violet-600 flex items-center gap-1 px-1 transition-colors"
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

export function ActionCard({ action }: { action: AgentAction }) {
  const label  = TOOL_LABELS[action.tool] ?? action.tool;
  const result = action.result as any;
  const ok     = result?.ok !== false && !result?.error;
  return (
    <div className={`rounded-xl px-3 py-2 border text-xs ${ok ? "bg-emerald-500/8 border-emerald-500/20" : "bg-rose-500/8 border-rose-500/20"}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={ok ? "text-emerald-600" : "text-rose-600"}>{ok ? "✓" : "✗"}</span>
        <span className={`font-semibold ${ok ? "text-emerald-700" : "text-rose-700"}`}>{label}</span>
      </div>
      <div className="text-white/[0.55] font-mono text-[10px] mb-0.5">
        {Object.entries(action.args).map(([k, v]) => (
          <span key={k} className="mr-2"><span className="text-white/[0.45]">{k}:</span> <span className="text-white/45">{String(v)}</span></span>
        ))}
      </div>
      {result?.message && <p className={`mt-0.5 text-[10px] ${ok ? "text-emerald-700/70" : "text-rose-700/70"}`}>{result.message}</p>}
      {result?.error   && <p className="mt-0.5 text-[10px] text-rose-600">{result.error}</p>}
    </div>
  );
}

export function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );
}

export function TaskCard({ task, onCancel }: { task: FmsTask; onCancel: () => void }) {
  const colorClass = TASK_COLORS[task.type] ?? "bg-[#FFCE99]/32 border-white/[0.12] text-white/[0.68]";
  const dotClass   = STATUS_DOT[task.status] ?? "bg-white/20";
  const elapsed    = task.startedAt ? Math.floor((Date.now() - new Date(task.startedAt).getTime()) / 1000) : null;
  return (
    <div className="glass-card !bg-[#FFCE99]/32 border-white/[0.1] p-4 hover:border-white/[0.12] transition-all group">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-1.5 h-1.5 rounded-full flex-none ${dotClass}`} />
          <span className={`text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border ${colorClass}`}>{taskTypeKo(task.type)}</span>
          <span className="text-xs text-white/[0.6] font-mono">→ {task.targetNode}</span>
        </div>
        {["PENDING", "ASSIGNED", "RUNNING"].includes(task.status) && (
          <button onClick={onCancel} title="태스크 취소" className="opacity-0 group-hover:opacity-100 text-white/[0.45] hover:text-rose-600 text-sm transition-all">✕</button>
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-white/[0.5]">
        <div className="flex items-center gap-3">
          <span className={`font-semibold ${
            task.status === "RUNNING" ? "text-emerald-600" : task.status === "ASSIGNED" ? "text-sky-600" :
            task.status === "FAILED" ? "text-rose-600" : "text-amber-600"
          }`}>{taskStatusKo(task.status)}</span>
          {task.assignedRobotId && <span className="text-white/[0.55] font-mono">@ {task.assignedRobotId}</span>}
        </div>
        <div className="flex items-center gap-3">
          {elapsed !== null && <span className="font-mono">{elapsed}초</span>}
          <span>우선순위 {task.priority}</span>
          <span>{new Date(task.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>
      {task.waitReason && <div className="mt-2 text-[10px] text-amber-600/60 italic">{task.waitReason}</div>}
    </div>
  );
}

// 로봇별 작업 묶음 — 현재 수행 / 대기(예정) / 최근 이력
export function RobotTaskGroup({
  robotId, tasks, online, status, onCancel,
}: {
  robotId: string;
  tasks: FmsTask[];
  online: boolean;
  status?: string;
  onCancel: (taskId: string) => void;
}) {
  // 이 로봇에 연관된 태스크 분류
  const mine = tasks.filter(t => t.assignedRobotId === robotId || t.preferredRobotId === robotId);
  const current  = mine.filter(t => ["ASSIGNED", "RUNNING"].includes(t.status));
  const upcoming = mine
    .filter(t => t.status === "PENDING")
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const history  = mine
    .filter(t => ["COMPLETED", "FAILED"].includes(t.status))
    .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())
    .slice(0, 5);

  const lbl = online ? robotStatusKo(status ?? "IDLE") : "오프라인";
  const lblColor = !online ? "text-white/[0.4]"
    : status === "ERROR" ? "text-rose-600"
    : status === "MOVING" || status === "WORKING" ? "text-amber-600"
    : "text-emerald-600";

  return (
    <div className="glass-card !bg-[#FFCE99]/32 border-white/[0.1] overflow-hidden">
      {/* 로봇 헤더 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.08] bg-[#FFCE99]/14">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400" : "bg-[#521C0D]/30"}`} />
          <span className="text-sm font-bold font-mono text-white/90">{robotId}</span>
          <span className={`text-[10px] font-bold tracking-wide ${lblColor}`}>{lbl}</span>
        </div>
        <span className="text-[10px] text-white/[0.5]">총 {mine.length}건</span>
      </div>

      <div className="p-3 space-y-3">
        {/* 현재 수행 중 */}
        <RobotTaskSection title="현재 수행" emptyText="수행 중인 태스크 없음">
          {current.map(t => (
            <RobotTaskRow key={t._id} task={t} cancelable onCancel={() => onCancel(t._id)} />
          ))}
        </RobotTaskSection>

        {/* 앞으로 할 태스크 (대기) */}
        <RobotTaskSection title="대기 예정" count={upcoming.length} emptyText="예정된 태스크 없음">
          {upcoming.map((t, i) => (
            <RobotTaskRow key={t._id} task={t} order={i + 1} cancelable onCancel={() => onCancel(t._id)} />
          ))}
        </RobotTaskSection>

        {/* 최근 이력 */}
        {history.length > 0 && (
          <RobotTaskSection title="최근 이력">
            {history.map(t => (
              <RobotTaskRow key={t._id} task={t} muted />
            ))}
          </RobotTaskSection>
        )}
      </div>
    </div>
  );
}

export function RobotTaskSection({
  title, count, emptyText, children,
}: {
  title: string; count?: number; emptyText?: string; children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[10px] font-bold tracking-widest text-white/[0.5] uppercase">{title}</span>
        {count != null && count > 0 && (
          <span className="text-[9px] font-bold text-white/[0.45] bg-[#FFCE99]/32 rounded px-1">{count}</span>
        )}
      </div>
      {hasChildren ? <div className="space-y-1.5">{children}</div>
        : emptyText && <p className="text-[10px] text-white/[0.35] italic pl-0.5">{emptyText}</p>}
    </div>
  );
}

export function RobotTaskRow({
  task, order, muted, cancelable, onCancel,
}: {
  task: FmsTask; order?: number; muted?: boolean; cancelable?: boolean; onCancel?: () => void;
}) {
  const colorClass = TASK_COLORS[task.type] ?? "bg-[#FFCE99]/32 border-white/[0.12] text-white/[0.68]";
  return (
    <div className={`group flex items-center gap-2 rounded-lg border border-white/[0.08] px-2.5 py-1.5 ${muted ? "opacity-55" : "bg-[#FFCE99]/14"}`}>
      {order != null && <span className="text-[10px] font-bold text-white/[0.4] w-4 text-center flex-none">{order}</span>}
      <span className={`text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded border flex-none ${colorClass}`}>{taskTypeKo(task.type)}</span>
      <span className="text-[11px] text-white/[0.7] font-mono truncate flex-1">→ {task.targetNode}</span>
      <span className="text-[9px] text-white/[0.45] flex-none">우선 {task.priority}</span>
      <span className={`text-[9px] font-semibold flex-none ${
        task.status === "RUNNING" ? "text-emerald-600" : task.status === "ASSIGNED" ? "text-sky-600" :
        task.status === "FAILED" ? "text-rose-600" : task.status === "COMPLETED" ? "text-white/[0.5]" : "text-amber-600"
      }`}>{taskStatusKo(task.status)}</span>
      {cancelable && onCancel && (
        <button onClick={onCancel} title="태스크 취소"
          className="opacity-0 group-hover:opacity-100 text-white/[0.4] hover:text-rose-600 text-xs flex-none transition-all">✕</button>
      )}
    </div>
  );
}
