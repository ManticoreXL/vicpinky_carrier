import type { FmsTask } from "../../hooks/useNestSocket";
import { taskTypeKo } from "../../utils/statusLabel";
import { robotIcon, statusDot } from "./shared";

// 시나리오(scenarioId 공유) — 로봇이 달라도 되는 단건들을 순서대로. 스텝마다 로봇 표시.
export function ScenarioCard({ tasks, onDelete }: { tasks: FmsTask[]; onDelete: (taskId: string) => void }) {
  const steps = [...tasks].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const total = steps.length;
  const done = steps.filter((t) => t.status === "COMPLETED").length;
  const failed = steps.some((t) => t.status === "FAILED");
  const running = steps.some((t) => ["RUNNING", "ASSIGNED"].includes(t.status));
  const deletable = steps.filter((t) => t.status === "DRAFT" || t.status === "PENDING");
  const border = failed ? "border-rose-500/40" : running ? "border-violet-400/50" : done === total ? "border-white/[0.12]" : "border-violet-400/35";

  return (
    <div className={`flex-none w-[calc((100%_-_3rem)/4)] min-w-[230px] rounded-xl bg-violet-400/[0.07] border-2 ${border} p-2.5 flex flex-col gap-2`}>
      {/* 헤더: 시나리오 배지 + 진행률 + 일괄 삭제 */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-extrabold tracking-wide px-2 py-0.5 rounded-md bg-violet-500 text-white">🎬 시나리오</span>
        <span className="text-[10px] text-white/55 font-bold">로봇별 순차</span>
        <span className="ml-auto text-[11px] font-mono font-bold text-violet-100 bg-black/20 px-1.5 py-0.5 rounded">{done}/{total}</span>
        {deletable.length > 0 && (
          <button onClick={() => deletable.forEach((t) => onDelete(t._id))} title="대기 스텝 일괄 삭제"
            className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/45 hover:text-white hover:bg-rose-500/50 text-[11px] leading-none">✕</button>
        )}
      </div>

      {/* 전체 진행 바 */}
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${failed ? "bg-rose-400/70" : "bg-violet-400/80"}`} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      {/* 스텝 리스트(실행 순서 · 로봇) */}
      <div className="flex flex-col gap-1 max-h-[140px] overflow-y-auto">
        {steps.map((t, i) => {
          const robot = t.assignedRobotId ?? t.preferredRobotId ?? "";
          return (
            <div key={t._id} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${["RUNNING", "ASSIGNED"].includes(t.status) ? "bg-emerald-500/15 border-emerald-400/40" : t.status === "COMPLETED" ? "bg-white/[0.03] border-white/[0.08] opacity-60" : t.status === "FAILED" ? "bg-rose-500/10 border-rose-400/40" : "bg-white/[0.05] border-white/[0.1]"}`}>
              <span className="text-[10px] font-extrabold text-violet-300 flex-none w-4 text-center">{i + 1}</span>
              <span className={`w-1.5 h-1.5 rounded-full flex-none ${statusDot(t.status)}`} />
              <span className="text-[10px] font-bold text-white/70 flex-none">{taskTypeKo(t.type)}</span>
              <span className="font-mono text-[11px] text-white/85 truncate flex-1">→ {t.type === "CHARGE" ? "충전" : t.type === "RECALL" && !t.targetNode ? "초기위치" : t.targetNode || "—"}</span>
              <span className="flex items-center gap-0.5 text-[9px] font-mono text-sky-300 flex-none max-w-[72px] truncate" title={robot}>{robotIcon(robot)}{robot}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
