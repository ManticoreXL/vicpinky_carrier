import { useEffect, useState } from "react";
import { PanelProps } from "../../hooks/useRos";
import ActionPanel from "../ActionPanel";
import type {
  ActionGoalPayload,
  ActionFeedback,
  ActionResult,
  ActiveGoals,
} from "../../hooks/useNestSocket";

interface StringMsg { data: string }
interface BatteryMsg { percentage: number }

interface Props extends PanelProps {
  emitAction: (payload: ActionGoalPayload) => void;
  cancelAction: (actionName: string, goalId: string) => void;
  activeGoals: ActiveGoals;
  actionFeedbacks: Record<string, ActionFeedback>;
  actionResults: Record<string, ActionResult>;
}

export default function BigPinkyPanel({
  subscribe, publish,
  emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
}: Props) {
  const [ramp, setRamp] = useState("unknown");
  const [battery, setBattery] = useState<number | null>(null);

  useEffect(() => {
    const subs = [
      subscribe<StringMsg>("/bigpinky/ramp/state", "std_msgs/String",
        (m) => setRamp(m.data)),
      subscribe<BatteryMsg>("/bigpinky/battery", "sensor_msgs/BatteryState",
        (m) => setBattery(Math.round(m.percentage * 100))),
    ];
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe]);

  const sendRamp = (cmd: string) =>
    publish("/bigpinky/ramp/cmd", "std_msgs/String", { data: cmd });

  const rampColor =
    ramp === "open" ? "text-green-400" : ramp === "closed" ? "text-red-400" : "text-blue-400/50";

  return (
    <div className="max-w-md">
      <PanelCard title="빅핑키" icon="🚛" accent="amber">
        {/* 경사로 상태 */}
        <Section label="경사로 상태">
          <div className="flex items-center justify-between">
            <BigStatus value={ramp} color={rampColor} />
            <div className="flex gap-2">
              <GoldButton onClick={() => sendRamp("open")}>열기</GoldButton>
              <DangerButton onClick={() => sendRamp("close")}>닫기</DangerButton>
            </div>
          </div>
        </Section>

        {/* 배터리 */}
        <Section label="배터리">
          {battery !== null ? (
            <BatteryBar pct={battery} />
          ) : (
            <NoData />
          )}
        </Section>

        {/* Action */}
        <ActionPanel
          robotNamespace="bigpinky"
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

/* ── shared UI ─────────────────────────────────────── */

export function PanelCard({
  title, icon, accent = "blue", badge, children,
}: {
  title: string;
  icon: string;
  accent?: "amber" | "blue" | "orange";
  badge?: string;
  children: React.ReactNode;
}) {
  const titleColor =
    accent === "amber" ? "text-amber-400" :
    accent === "orange" ? "text-orange-400" : "text-blue-400";

  return (
    <div className="bg-[#051929] border border-blue-800/40 rounded-2xl p-5 flex flex-col gap-5 shadow-xl shadow-blue-950/50">
      <div className="flex items-center justify-between">
        <h2 className={`text-xl font-bold flex items-center gap-2 ${titleColor}`}>
          <span>{icon}</span>
          {title}
        </h2>
        {badge && (
          <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-md bg-blue-900/60 border border-blue-700/50 text-blue-300 tracking-wide">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-semibold text-amber-400/50 uppercase tracking-widest">{label}</p>
      <div className="bg-[#020e25] rounded-xl p-3 border border-blue-900/60">
        {children}
      </div>
    </div>
  );
}

export function BigStatus({ value, color }: { value: string; color: string }) {
  return (
    <span className={`text-2xl font-bold capitalize ${color}`}>{value}</span>
  );
}

export function BatteryBar({ pct }: { pct: number }) {
  const fill = pct < 20 ? "bg-red-500" : pct < 50 ? "bg-amber-500" : "bg-green-500";
  const text = pct < 20 ? "text-red-400" : pct < 50 ? "text-amber-400" : "text-green-400";
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-blue-950 rounded-full overflow-hidden border border-blue-900/60">
        <div
          className={`h-full rounded-full transition-all ${fill}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-sm font-bold tabular-nums w-10 text-right ${text}`}>{pct}%</span>
    </div>
  );
}

export function GoldButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-[#010c1e] text-sm font-bold transition-colors shadow-md shadow-amber-500/20"
    >
      {children}
    </button>
  );
}

export function BlueButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm font-semibold transition-colors"
    >
      {children}
    </button>
  );
}

export function DangerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-1.5 rounded-lg bg-red-800/80 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
    >
      {children}
    </button>
  );
}

export function NoData() {
  return <span className="text-sm text-blue-400/30 italic">데이터 없음</span>;
}
