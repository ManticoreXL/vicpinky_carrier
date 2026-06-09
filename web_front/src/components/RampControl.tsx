import { useState, useEffect, useCallback } from "react";
import type {
  ActionGoalPayload,
  ActionFeedback,
  ActionResult,
  ActiveGoals,
} from "../hooks/useNestSocket";

// ── 액션/토픽 정의 (namespace: vicpinky) ───────────────────────────────────────
const RAMP_ACTION = "/vicpinky/ramp_control";
const RAMP_ACTION_TYPE = "vicpinky_carrier_interfaces/action/RampControl";

// 현재 램프 상태 토픽 데이터
export interface RampStateMsg {
  ramp_state?: string; // "Open" | "Closed" ...
  ramp_angle?: string; // "180.0"
}

interface Props {
  emitAction: (payload: ActionGoalPayload) => void;
  cancelAction: (actionName: string, goalId: string) => void;
  activeGoals: ActiveGoals;
  actionFeedbacks: Record<string, ActionFeedback>;
  actionResults: Record<string, ActionResult>;
  rampState?: RampStateMsg; // /vicpinky/ramp_state 토픽
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
export default function RampControl({
  emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults, rampState,
}: Props) {
  // 보낸 명령(O/C)과 마지막 goalId 추적
  const [lastTarget, setLastTarget]     = useState<"O" | "C" | null>(null);
  const [lastGoalId, setLastGoalId]     = useState<string | null>(null);

  // 새 goal이 수락되면 그 goalId 기억 (완료 후에도 결과 조회용)
  useEffect(() => {
    const gid = activeGoals[RAMP_ACTION];
    if (gid) setLastGoalId(gid);
  }, [activeGoals]);

  const running  = !!activeGoals[RAMP_ACTION];                       // 진행 중
  const feedback = lastGoalId ? actionFeedbacks[lastGoalId]?.feedback : undefined;
  const resultMsg = lastGoalId ? actionResults[lastGoalId] : undefined;
  const result   = resultMsg?.result as
    | { success?: boolean; final_state?: string; final_angle?: number }
    | undefined;
  const fb = feedback as { current_angle?: number; current_load?: number } | undefined;

  const send = useCallback((target: "O" | "C") => {
    if (running) return;
    setLastTarget(target);
    emitAction({
      actionName: RAMP_ACTION,
      actionType: RAMP_ACTION_TYPE,
      goal: { target_string: target },
    });
  }, [emitAction, running]);

  const stop = useCallback(() => {
    const gid = activeGoals[RAMP_ACTION];
    if (gid) cancelAction(RAMP_ACTION, gid);
  }, [cancelAction, activeGoals]);

  return (
    <div className="border border-[#1e1e1e] bg-[#0a0a0f] rounded-lg overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#161616]">
        <span className="text-[10px] font-mono font-bold text-pink-400 uppercase tracking-[0.2em]">
          ▤ 램프 제어
        </span>
        <span className={`text-[10px] font-mono ${
          running ? "text-amber-400 animate-pulse" :
          result?.success ? "text-green-400" :
          result && !result.success ? "text-red-400" : "text-[#444444]"
        }`}>
          {running ? "동작 중…" :
           result?.success ? "완료" :
           result && !result.success ? "실패" : "대기"}
        </span>
      </div>

      <div className="p-3 space-y-3">
        {/* 현재 램프 상태 (/vicpinky/ramp_state 토픽) */}
        <div className="flex items-center justify-between border border-[#1a1a1a] bg-[#0c0c0c] px-2.5 py-1.5">
          <span className="text-[9px] text-[#444444] uppercase tracking-widest">현재 상태</span>
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className={
              rampState?.ramp_state === "Open"   ? "text-green-400" :
              rampState?.ramp_state === "Closed" ? "text-blue-400" : "text-[#666666]"
            }>
              {rampState?.ramp_state ?? "—"}
            </span>
            <span className="text-[#444444]">|</span>
            <span className="text-[#c0c0c0]">
              {rampState?.ramp_angle != null ? `${rampState.ramp_angle}°` : "—"}
            </span>
          </div>
        </div>

        {/* O / C 버튼 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => send("O")}
            disabled={running}
            className={`py-2.5 text-xs font-mono font-bold uppercase tracking-widest border transition-all ${
              running
                ? "border-[#1a1a1a] text-[#333333] cursor-not-allowed"
                : "border-green-800/60 bg-green-950/30 text-green-400 hover:border-green-600 hover:text-green-300"
            }`}>
            ▲ 열기 (O)
          </button>
          <button
            onClick={() => send("C")}
            disabled={running}
            className={`py-2.5 text-xs font-mono font-bold uppercase tracking-widest border transition-all ${
              running
                ? "border-[#1a1a1a] text-[#333333] cursor-not-allowed"
                : "border-blue-800/60 bg-blue-950/30 text-blue-400 hover:border-blue-600 hover:text-blue-300"
            }`}>
            ▼ 닫기 (C)
          </button>
        </div>

        {/* 진행 중이면 중단 버튼 */}
        {running && (
          <button
            onClick={stop}
            className="w-full py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest
                       border border-red-800/60 bg-red-950/30 text-red-400
                       hover:border-red-600 hover:text-red-300 transition-all">
            중단
          </button>
        )}

        {/* 보낸 명령 */}
        {lastTarget && (
          <div className="text-[10px] font-mono text-[#666666]">
            명령: <span className="text-pink-300">{lastTarget === "O" ? "열기(O)" : "닫기(C)"}</span>
          </div>
        )}

        {/* 피드백 (실시간) */}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="현재 각도" value={fb?.current_angle != null ? `${fb.current_angle}` : "—"}
            highlight={running} />
          <Stat label="부하(load)" value={fb?.current_load != null ? `${fb.current_load}` : "—"}
            highlight={running} />
        </div>

        {/* 결과 */}
        {result && (
          <div className={`border rounded p-2 space-y-1 ${
            result.success ? "border-green-900/50 bg-green-950/20" : "border-red-900/50 bg-red-950/20"
          }`}>
            <div className="flex justify-between text-[10px] font-mono">
              <span className="text-[#666666]">성공</span>
              <span className={result.success ? "text-green-400" : "text-red-400"}>
                {result.success ? "true" : "false"}
              </span>
            </div>
            <div className="flex justify-between text-[10px] font-mono">
              <span className="text-[#666666]">최종 상태</span>
              <span className="text-[#c0c0c0]">{result.final_state ?? "—"}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono">
              <span className="text-[#666666]">최종 각도</span>
              <span className="text-[#c0c0c0]">{result.final_angle ?? "—"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 작은 스탯 박스 ──────────────────────────────────────────────────────────────
function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`border px-2 py-1.5 ${
      highlight ? "border-amber-900/50 bg-amber-950/10" : "border-[#1a1a1a] bg-[#0c0c0c]"
    }`}>
      <p className="text-[9px] text-[#444444] uppercase">{label}</p>
      <p className={`text-sm font-mono tabular-nums mt-0.5 ${highlight ? "text-amber-300" : "text-[#c0c0c0]"}`}>
        {value}
      </p>
    </div>
  );
}
