import { useEffect, useState } from "react";
import { SubscribeFn } from "../hooks/useRos";
import { RobotId } from "../types/robots";
import { useThrottled } from "../hooks/useThrottled";

interface VicPinkyStatus { x: number | null; y: number | null; scanReceived: boolean }
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
  const [vp, setVp]     = useState<VicPinkyStatus>({ x: null, y: null, scanReceived: false });
  const [bots, setBots] = useState<Record<string, BotStatus>>(
    Object.fromEntries(TURTLEBOTS.map((id) => [id, initBot()]))
  );
  const [omx, setOmx] = useState<OmxStatus>({ omx1: "unknown", omx2: "unknown" });

  // 1초 단위 표시
  const displayVp   = useThrottled(vp,   1000);
  const displayBots = useThrottled(bots, 1000);
  const displayOmx  = useThrottled(omx,  1000);

  useEffect(() => {
    const subs: (ROSLIB.Topic | null)[] = [];

    // VicPinky — odom으로 위치 표시, scan으로 수신 여부 확인
    subs.push(subscribe<{
      pose: { pose: { position: { x: number; y: number } } }
    }>("/vicpinky/odom", "nav_msgs/Odometry",
      (m) => setVp((p) => ({
        ...p,
        x: Math.round(m.pose.pose.position.x * 100) / 100,
        y: Math.round(m.pose.pose.position.y * 100) / 100,
      }))));
    subs.push(subscribe<{ ranges: number[] }>("/vicpinky/scan", "sensor_msgs/LaserScan",
      () => setVp((p) => ({ ...p, scanReceived: true }))));

    // TurtleBot3 × 4
    TURTLEBOTS.forEach((id) => {
      subs.push(subscribe<{ data: string }>(`/${id}/mode`, "std_msgs/String",
        (m) => setBots((p) => ({ ...p, [id]: { ...p[id], mode: m.data } }))));
      subs.push(subscribe<{ data: boolean }>(`/${id}/yolo/person_detected`, "std_msgs/Bool",
        (m) => setBots((p) => ({ ...p, [id]: { ...p[id], detected: m.data } }))));
      subs.push(subscribe<{ percentage: number }>(`/${id}/battery_state`, "sensor_msgs/BatteryState",
        (m) => setBots((p) => ({
          ...p,
          [id]: { ...p[id], battery: Math.round(m.percentage > 1 ? m.percentage : m.percentage * 100) },
        }))));
    });

    // OMX (토픽 준비 중 — vicpinky 네임스페이스)
    subs.push(subscribe<{ data: string }>("/vicpinky/omx1/state", "std_msgs/String",
      (m) => setOmx((p) => ({ ...p, omx1: m.data }))));
    subs.push(subscribe<{ data: string }>("/vicpinky/omx2/state", "std_msgs/String",
      (m) => setOmx((p) => ({ ...p, omx2: m.data }))));

    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe]);

  return (
    <aside className="w-48 flex-none bg-[#080808] border-r border-red-900/30 flex flex-col overflow-y-auto">
      {/* 이동 로봇 */}
      <section className="px-2.5 pt-3">
        <SectionLabel>이동 로봇</SectionLabel>

        <RobotItem id="vicpinky" icon="▶" label="VICPINKY"
          selected={selectedRobot === "vicpinky"} onSelect={onSelect}>
          {displayVp.x !== null ? (
            <>
              <StatRow label="X" value={`${displayVp.x.toFixed(2)} m`} />
              <StatRow label="Y" value={`${displayVp.y?.toFixed(2) ?? "—"} m`} />
            </>
          ) : (
            <StatRow label="odom" value="대기 중" />
          )}
          <StatRow label="LIDAR" value={displayVp.scanReceived ? "수신 중" : "대기 중"} />
        </RobotItem>

        {TURTLEBOTS.map((id, i) => {
          const s = displayBots[id];
          return (
            <RobotItem key={id} id={id} icon="▶" label={`TB3-0${i + 1}`}
              selected={selectedRobot === id} onSelect={onSelect}>
              <StatRow label="모드" value={s.mode} />
              {s.detected && (
                <span className="text-[10px] text-red-500 font-mono font-bold danger-pulse">⚠ PERSON</span>
              )}
              {s.battery !== null && <BatteryRow pct={s.battery} />}
            </RobotItem>
          );
        })}
      </section>

      {/* 로봇 팔 */}
      <section className="px-2.5 pt-2 pb-4 mt-2 border-t border-red-900/20">
        <SectionLabel>로봇 팔</SectionLabel>
        <RobotItem id="omx" icon="▶" label="OMX ARM"
          selected={selectedRobot === "omx"} onSelect={onSelect}>
          <StatRow label="OMX1" value={displayOmx.omx1} />
          <StatRow label="OMX2" value={displayOmx.omx2} />
        </RobotItem>
      </section>
    </aside>
  );
}

/* ── sub-components ─────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-bold text-red-900/70 uppercase tracking-[0.3em] mb-2 px-1 flex items-center gap-1">
      <span className="w-3 h-px bg-red-900/60" />
      {children}
    </p>
  );
}

function RobotItem({ id, icon, label, selected, onSelect, children }: {
  id: RobotId; icon: string; label: string;
  selected: boolean; onSelect: (id: RobotId) => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className={`w-full text-left px-2.5 py-2 mb-0.5 transition-all border-l-2 ${
        selected
          ? "bg-red-950/30 border-red-600 shadow-sm shadow-red-900/30"
          : "border-transparent hover:bg-[#111111] hover:border-red-900/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-bold ${selected ? "text-red-500" : "text-[#333333]"}`}>{icon}</span>
        <span className={`text-[11px] font-bold tracking-widest uppercase font-mono ${
          selected ? "text-[#c0c0c0]" : "text-[#555555]"
        }`}>{label}</span>
      </div>
      <div className="pl-5 mt-1 flex flex-col gap-0.5">{children}</div>
    </button>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  const isDim = value === "unknown" || value === "대기 중" || value === "—";
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-[#333333] font-mono">{label}</span>
      <span className={`font-mono ${isDim ? "text-[#2a2a2a]" : "text-[#888888]"}`}>{value}</span>
    </div>
  );
}

function BatteryRow({ pct }: { pct: number }) {
  const color = pct < 20 ? "text-red-500" : pct < 50 ? "text-[#888888]" : "text-green-600";
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-[#333333] font-mono">BAT</span>
      <span className={`font-mono font-bold ${color}`}>{pct}%</span>
    </div>
  );
}
