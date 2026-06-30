import { useState, useEffect, useCallback } from "react";
import type {
 ActionGoalPayload,
 ActionFeedback,
 ActionResult,
 ActiveGoals,
} from "../../hooks/useNestSocket";

// ── 액션 정의 — 허브(49) 발행 → 도메인 브리지 → vicpinky(40) /marker_trace ──
const MARKER_ACTION = "/marker_trace";
const MARKER_ACTION_TYPE = "vicpinky_carrier_interfaces/action/MarkerTrace";

const BOT_NUMS = [1, 2, 3, 4] as const;
type BotAction = "Park" | "Load";

interface Props {
 emitAction: (payload: ActionGoalPayload) => void;
 cancelAction: (actionName: string, goalId: string) => void;
 activeGoals: ActiveGoals;
 actionFeedbacks: Record<string, ActionFeedback>;
 actionResults: Record<string, ActionResult>;
}

// 터틀봇 마커 추종 — 이동시킬 터틀봇 번호(bot_num)와 동작(bot_action: Park/Load)을 보낸다.
export default function MarkerTrace({
 emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
}: Props) {
 const [botNum, setBotNum] = useState<number>(1);
 const [lastGoalId, setLastGoalId] = useState<string | null>(null);
 const [lastSent, setLastSent] = useState<{ botNum: number; action: BotAction } | null>(null);

 // 새 goal이 수락되면 goalId 기억 (완료 후 결과 조회용)
 useEffect(() => {
  const gid = activeGoals[MARKER_ACTION];
  if (gid) setLastGoalId(gid);
 }, [activeGoals]);

 const running = !!activeGoals[MARKER_ACTION];
 const feedback = lastGoalId ? actionFeedbacks[lastGoalId]?.feedback : undefined;
 const resultMsg = lastGoalId ? actionResults[lastGoalId] : undefined;
 const result = resultMsg?.result as { success?: boolean; action_result?: string } | undefined;
 const fb = feedback as { current_state?: string } | undefined;

 const send = useCallback((action: BotAction) => {
  if (running) return;
  setLastSent({ botNum, action });
  emitAction({
   actionName: MARKER_ACTION,
   actionType: MARKER_ACTION_TYPE,
   goal: { bot_num: botNum, bot_action: action },
  });
 }, [emitAction, running, botNum]);

 const stop = useCallback(() => {
  const gid = activeGoals[MARKER_ACTION];
  if (gid) cancelAction(MARKER_ACTION, gid);
 }, [cancelAction, activeGoals]);

 return (
  <div className="border border-white/[0.1] bg-[#FFCE99]/14 backdrop-blur-xl rounded-lg overflow-hidden">
   {/* 헤더 */}
   <div className="flex items-center justify-between px-3 py-2 border-b border-[#521C0D]/10">
    <span className="text-xs font-bold text-pink-600 tracking-wide">✥ 마커 추종 (MarkerTrace)</span>
    <span className={`text-xs ${
     running ? "text-white/90 animate-pulse" :
     result?.success ? "text-white/90" :
     result && !result.success ? "text-white/90" : "text-white/[0.6]"
    }`}>
     {running ? "동작 중…" :
      result?.success ? "완료" :
      result && !result.success ? "실패" : "대기"}
    </span>
   </div>

   <div className="p-3 space-y-3">
    {/* 이동시킬 터틀봇 번호 (bot_num) */}
    <div>
     <p className="text-xs text-white/[0.6] tracking-wide mb-1.5">이동시킬 터틀봇 (bot_num)</p>
     <div className="grid grid-cols-4 gap-2">
      {BOT_NUMS.map((n) => (
       <button key={n} onClick={() => setBotNum(n)} disabled={running}
        className={`py-2 text-xs font-bold tracking-wide border transition-all ${
         botNum === n
          ? "border-pink-500/50 bg-pink-500/15 text-pink-300"
          : "border-white/[0.1] bg-[#FFCE99]/32 text-white/[0.7] hover:border-white/[0.12] hover:text-white/90"
        } ${running ? "cursor-not-allowed opacity-60" : ""}`}>
        {n}
       </button>
      ))}
     </div>
    </div>

    {/* 동작 (bot_action) — 선택된 번호로 즉시 전송 */}
    <div className="grid grid-cols-2 gap-2">
     <button onClick={() => send("Park")} disabled={running}
      className={`py-2.5 text-xs font-bold tracking-wide border transition-all ${
       running
        ? "border-white/[0.1] text-white/[0.55] cursor-not-allowed"
        : "border-white/[0.1] bg-blue-950/30 text-white/90 hover:border-blue-600 hover:text-white/[0.82]"
      }`}>
      ⊓ Park
     </button>
     <button onClick={() => send("Load")} disabled={running}
      className={`py-2.5 text-xs font-bold tracking-wide border transition-all ${
       running
        ? "border-white/[0.1] text-white/[0.55] cursor-not-allowed"
        : "border-white/[0.1] bg-green-950/30 text-white/90 hover:border-green-600 hover:text-white/[0.82]"
      }`}>
      ⊔ Load
     </button>
    </div>

    {/* 진행 중이면 중단 */}
    {running && (
     <button onClick={stop}
      className="w-full py-1.5 text-xs font-bold tracking-wide
                 border border-white/[0.1] bg-red-950/30 text-white/90
                 hover:border-red-600 hover:text-white/[0.82] transition-all">
      중단
     </button>
    )}

    {/* 보낸 명령 */}
    {lastSent && (
     <div className="text-xs text-white/[0.75]">
      명령: <span className="text-pink-700">터틀봇 {lastSent.botNum} · {lastSent.action}</span>
     </div>
    )}

    {/* 피드백 — current_state */}
    <div className="flex items-center justify-between border border-white/[0.1] bg-[#FFCE99]/32 px-2.5 py-1.5">
     <span className="text-xs text-white/[0.6] tracking-wide">현재 상태</span>
     <span className={`text-xs ${running ? "text-white/[0.82]" : "text-white/90"}`}>{fb?.current_state ?? "—"}</span>
    </div>

    {/* 결과 — success / action_result */}
    {result && (
     <div className={`border rounded p-2 space-y-1 ${
      result.success ? "border-white/[0.1] bg-green-950/20" : "border-white/[0.1] bg-red-950/20"
     }`}>
      <div className="flex justify-between text-xs">
       <span className="text-white/[0.75]">성공</span>
       <span className="text-white/90">{result.success ? "true" : "false"}</span>
      </div>
      <div className="flex justify-between text-xs">
       <span className="text-white/[0.75]">결과</span>
       <span className="text-white/90">{result.action_result ?? "—"}</span>
      </div>
     </div>
    )}
   </div>
  </div>
 );
}
