import type { FmsTask } from "../../hooks/useNestSocket";
import { taskTypeKo, taskStatusKo } from "../../utils/statusLabel";
import { robotIcon, statusDot } from "./shared";

// 연속(batchId 공유) 태스크들을 한 카드에 묶어 표현 — 로봇 1대 + 단계 리스트 + 진행률
export function BatchCard({ tasks, onDelete, onStop }: { tasks: FmsTask[]; onDelete: (taskId: string) => void; onStop: (batchId: string) => void }) {
  const steps = [...tasks].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const robot = steps.find((t) => t.assignedRobotId)?.assignedRobotId ?? steps[0]?.preferredRobotId ?? "";
  const total = steps.length;
  const done = steps.filter((t) => t.status === "COMPLETED").length;
  const failed = steps.some((t) => t.status === "FAILED");
  const running = steps.some((t) => t.status === "RUNNING");
  const isRepeat = steps.some((t) => t.repeat); // 백엔드 repeat 플래그 — 정지하면 false로 내려옴
  const deletable = steps.filter((t) => t.status === "DRAFT" || t.status === "PENDING");
  const border = failed ? "border-rose-500/40" : isRepeat ? "border-amber-400/70" : running ? "border-amber-400/50" : done === total ? "border-white/[0.12]" : "border-amber-400/35";

  return (
    <div className={`flex-none w-[calc((100%_-_3rem)/4)] min-w-[230px] rounded-xl bg-amber-400/[0.07] border-2 ${border} p-2.5 flex flex-col gap-2`}>
      {/* 헤더: 연속/반복 배지 + 로봇 + 진행률 + 정지(반복)/일괄 삭제 */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-extrabold tracking-wide px-2 py-0.5 rounded-md bg-amber-500 text-black">{isRepeat ? "🔁 반복" : "⛓ 연속"}</span>
        <span className="flex items-center gap-1 font-mono font-extrabold text-[13px] text-white truncate">
          <span className="text-base leading-none">{robotIcon(robot)}</span>{robot}
        </span>
        <span className="ml-auto text-[11px] font-mono font-bold text-amber-200 bg-black/20 px-1.5 py-0.5 rounded">{done}/{total}</span>
        {isRepeat ? (
          <button onClick={() => steps[0]?.batchId && onStop(steps[0].batchId)} title="반복 정지 (현재 태스크 완료 처리 후 종료)"
            className="flex-none px-2 py-0.5 text-[10px] font-extrabold rounded-md bg-rose-500 text-white border border-rose-300/50 hover:bg-rose-400">■ 정지</button>
        ) : deletable.length > 0 && (
          <button onClick={() => deletable.forEach((t) => onDelete(t._id))} title="대기 단계 일괄 삭제"
            className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/45 hover:text-white hover:bg-rose-500/50 text-[11px] leading-none">✕</button>
        )}
      </div>

      {/* 전체 진행 바 */}
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${failed ? "bg-rose-400/70" : "bg-amber-400/80"}`} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      {/* 단계 리스트(실행 순서) */}
      <div className="flex flex-col gap-1 max-h-[140px] overflow-y-auto">
        {steps.map((t, i) => (
          <div key={t._id} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${t.status === "RUNNING" ? "bg-emerald-500/15 border-emerald-400/40" : t.status === "COMPLETED" ? "bg-white/[0.03] border-white/[0.08] opacity-60" : t.status === "FAILED" ? "bg-rose-500/10 border-rose-400/40" : "bg-white/[0.05] border-white/[0.1]"}`}>
            <span className="text-[10px] font-extrabold text-amber-300 flex-none w-4 text-center">{i + 1}</span>
            <span className={`w-1.5 h-1.5 rounded-full flex-none ${statusDot(t.status)}`} />
            <span className="text-[10px] font-bold text-white/70 flex-none">{taskTypeKo(t.type)}</span>
            <span className="font-mono text-[11px] text-white/85 truncate flex-1">→ {t.targetNode}</span>
            <span className="text-[9px] font-bold text-white/55 flex-none">{taskStatusKo(t.status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
