import { useEffect, useState } from "react";
import { SubscribeFn } from "../hooks/useRos";
import { RobotId } from "../types/robots";

interface BigPinkyStatus { ramp: string; battery: number | null }
interface BotStatus { mode: string; detected: boolean; battery: number | null }
interface OmxStatus { omx1: string; omx2: string }

const TURTLEBOTS = ["tb3_01", "tb3_02", "tb3_03", "tb3_04"] as const;

const initBot = (): BotStatus => ({ mode: "unknown", detected: false, battery: null });

interface Props {
  subscribe: SubscribeFn;
  selectedRobot: RobotId;
  onSelect: (id: RobotId) => void;
}

export default function RobotSidebar({ subscribe, selectedRobot, onSelect }: Props) {
  const [bp, setBp] = useState<BigPinkyStatus>({ ramp: "unknown", battery: null });
  const [bots, setBots] = useState<Record<string, BotStatus>>(
    Object.fromEntries(TURTLEBOTS.map((id) => [id, initBot()]))
  );
  const [omx, setOmx] = useState<OmxStatus>({ omx1: "unknown", omx2: "unknown" });

  useEffect(() => {
    const subs: (ROSLIB.Topic | null)[] = [];

    subs.push(subscribe<{ data: string }>("/bigpinky/ramp/state", "std_msgs/String",
      (m) => setBp((p) => ({ ...p, ramp: m.data }))));
    subs.push(subscribe<{ percentage: number }>("/bigpinky/battery", "sensor_msgs/BatteryState",
      (m) => setBp((p) => ({ ...p, battery: Math.round(m.percentage * 100) }))));

    TURTLEBOTS.forEach((id) => {
      subs.push(subscribe<{ data: string }>(`/${id}/mode`, "std_msgs/String",
        (m) => setBots((p) => ({ ...p, [id]: { ...p[id], mode: m.data } }))));
      subs.push(subscribe<{ data: boolean }>(`/${id}/yolo/person_detected`, "std_msgs/Bool",
        (m) => setBots((p) => ({ ...p, [id]: { ...p[id], detected: m.data } }))));
      subs.push(subscribe<{ percentage: number }>(`/${id}/battery_state`, "sensor_msgs/BatteryState",
        (m) => setBots((p) => ({ ...p, [id]: { ...p[id], battery: Math.round(m.percentage * 100) } }))));
    });

    subs.push(subscribe<{ data: string }>("/bigpinky/omx1/state", "std_msgs/String",
      (m) => setOmx((p) => ({ ...p, omx1: m.data }))));
    subs.push(subscribe<{ data: string }>("/bigpinky/omx2/state", "std_msgs/String",
      (m) => setOmx((p) => ({ ...p, omx2: m.data }))));

    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe]);

  return (
    <aside className="w-52 flex-none bg-[#02091a] border-r border-amber-400/15 flex flex-col overflow-y-auto">
      {/* 이동 로봇 */}
      <section className="px-3 pt-4">
        <SectionLabel>이동 로봇</SectionLabel>

        <RobotItem
          id="bigpinky"
          icon="🚛"
          label="빅핑키"
          selected={selectedRobot === "bigpinky"}
          onSelect={onSelect}
        >
          <StatRow label="경사로" value={bp.ramp} />
          {bp.battery !== null && <BatteryRow pct={bp.battery} />}
        </RobotItem>

        {TURTLEBOTS.map((id, i) => {
          const s = bots[id];
          return (
            <RobotItem
              key={id}
              id={id}
              icon="🤖"
              label={`터틀봇 ${i + 1}`}
              selected={selectedRobot === id}
              onSelect={onSelect}
            >
              <StatRow label="모드" value={s.mode} />
              {s.detected && (
                <span className="text-[10px] text-yellow-400 font-medium">⚠ 사람 감지</span>
              )}
              {s.battery !== null && <BatteryRow pct={s.battery} />}
            </RobotItem>
          );
        })}
      </section>

      {/* 로봇 팔 */}
      <section className="px-3 pt-3 pb-4 mt-2 border-t border-amber-400/10">
        <SectionLabel>로봇 팔</SectionLabel>

        <RobotItem
          id="omx"
          icon="🦾"
          label="OMX 로봇팔"
          selected={selectedRobot === "omx"}
          onSelect={onSelect}
        >
          <StatRow label="OMX1" value={omx.omx1} />
          <StatRow label="OMX2" value={omx.omx2} />
        </RobotItem>
      </section>
    </aside>
  );
}

/* ── sub-components ─────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold text-amber-400/50 uppercase tracking-widest mb-2 px-1">
      {children}
    </p>
  );
}

function RobotItem({
  id, icon, label, selected, onSelect, children,
}: {
  id: RobotId;
  icon: string;
  label: string;
  selected: boolean;
  onSelect: (id: RobotId) => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className={`w-full text-left rounded-lg px-2 py-2 mb-1 transition-all border-l-2
        ${selected
          ? "bg-amber-400/10 border-amber-400"
          : "border-transparent hover:bg-blue-900/30 hover:border-blue-700/40"
        }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className={`text-sm font-semibold ${selected ? "text-amber-300" : "text-blue-100"}`}>
          {label}
        </span>
      </div>
      <div className="pl-6 mt-1 flex flex-col gap-0.5">
        {children}
      </div>
    </button>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  const isUnknown = value === "unknown";
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-blue-300/50">{label}</span>
      <span className={isUnknown ? "text-gray-600" : "text-blue-200"}>{value}</span>
    </div>
  );
}

function BatteryRow({ pct }: { pct: number }) {
  const color = pct < 20 ? "text-red-400" : pct < 50 ? "text-amber-400" : "text-green-400";
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-blue-300/50">배터리</span>
      <span className={`font-medium ${color}`}>🔋 {pct}%</span>
    </div>
  );
}
