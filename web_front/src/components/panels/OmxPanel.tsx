import { useEffect, useState, useCallback, useRef } from "react";
import { PanelProps } from "../../hooks/useRos";
import { PanelCard, Section, GoldButton, BlueButton, DangerButton } from "./BigPinkyPanel";
import ActionPanel from "../ActionPanel";
import type {
  ActionGoalPayload,
  ActionFeedback,
  ActionResult,
  ActiveGoals,
} from "../../hooks/useNestSocket";

type DiagStatus = "idle" | "loading" | "ok" | "error";

interface StringMsg { data: string }

const ARMS = ["omx1", "omx2"] as const;
type ArmId = (typeof ARMS)[number];

const stateColor = (s: string) =>
  s === "load"    ? "text-amber-400" :
  s === "unload"  ? "text-blue-400" :
  s === "home"    ? "text-green-400" : "text-blue-400/40";

interface Props extends PanelProps {
  emitAction: (payload: ActionGoalPayload) => void;
  cancelAction: (actionName: string, goalId: string) => void;
  activeGoals: ActiveGoals;
  actionFeedbacks: Record<string, ActionFeedback>;
  actionResults: Record<string, ActionResult>;
  callService: (serviceName: string, serviceType: string, request: Record<string, unknown>, callback: (res: unknown) => void) => void;
}

export default function OmxPanel({
  subscribe, publish,
  emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
  callService,
}: Props) {
  const [states, setStates] = useState<Record<ArmId, string>>({ omx1: "unknown", omx2: "unknown" });
  const [diagStatus, setDiagStatus] = useState<DiagStatus>("idle");
  const diagTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const subs = ARMS.map((id) =>
      subscribe<StringMsg>(`/vicpinky/${id}/state`, "std_msgs/String",
        (m) => setStates((p) => ({ ...p, [id]: m.data })))
    );
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe]);

  const sendCmd = (id: ArmId, cmd: string) =>
    publish(`/vicpinky/${id}/cmd`, "std_msgs/String", { data: cmd });

  const runDiagnosis = useCallback(() => {
    setDiagStatus("loading");
    if (diagTimeoutRef.current) clearTimeout(diagTimeoutRef.current);
    callService(
      "/vicpinky/run_diagnosis",
      "turtlebot3_custom_msgs/srv/SelfDiagnosis",
      { target_component: "all" },
      (res) => {
        const r = res as { is_ok?: boolean };
        const next: DiagStatus = r.is_ok ? "ok" : "error";
        setDiagStatus(next);
        diagTimeoutRef.current = setTimeout(() => setDiagStatus("idle"), 5000);
      },
    );
  }, [callService]);

  return (
    <div className="max-w-md flex flex-col gap-4">
      <PanelCard title="OMX 로봇팔" icon="🦾" accent="orange">
        {ARMS.map((id) => (
          <Section key={id} label={id.toUpperCase()}>
            <div className="flex items-center justify-between gap-4">
              <span className={`text-2xl font-bold capitalize ${stateColor(states[id])}`}>
                {states[id]}
              </span>
              <div className="flex gap-2">
                <GoldButton onClick={() => sendCmd(id, "load")}>적재</GoldButton>
                <BlueButton onClick={() => sendCmd(id, "unload")}>하역</BlueButton>
                <DangerButton onClick={() => sendCmd(id, "home")}>홈</DangerButton>
              </div>
            </div>
          </Section>
        ))}
        {/* ── 자가진단 */}
        <Section label="자가진단">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              {diagStatus === "idle"    && <span className="text-[10px] text-[#2a2a2a] font-mono uppercase tracking-widest">대기 중</span>}
              {diagStatus === "loading" && <span className="text-[10px] text-amber-400 font-mono uppercase tracking-widest animate-pulse">진단 중…</span>}
              {diagStatus === "ok"      && <span className="text-[10px] text-green-500 font-mono font-black uppercase tracking-widest">◉ 정상</span>}
              {diagStatus === "error"   && <span className="text-[10px] text-red-500 font-mono font-black uppercase tracking-widest danger-pulse">⚠ 이상 감지</span>}
            </div>
            <BlueButton onClick={runDiagnosis} disabled={diagStatus === "loading"}>
              자가진단 시작
            </BlueButton>
          </div>
        </Section>

        {/* Action */}
        <ActionPanel
          robotNamespace="vicpinky"
          emitAction={emitAction}
          cancelAction={cancelAction}
          activeGoals={activeGoals}
          actionFeedbacks={actionFeedbacks}
          actionResults={actionResults}
        />
      </PanelCard>
    </div>
  );
}
