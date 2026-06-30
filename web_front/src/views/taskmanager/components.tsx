import type { FmsTask } from "../../hooks/useNestSocket";
import { taskTypeKo } from "../../utils/statusLabel";
import { ROBOTS, TASK_COLORS } from "./constants";
import { robotVisual } from "./helpers";

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────────
// (태스크 카드는 글로벌 태스크 큐의 TaskMiniCard 재사용, AI 챗봇은 전역 <AiAssistant/> 사용)

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
