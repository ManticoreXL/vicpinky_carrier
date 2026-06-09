/**
 * VicPinky 패널 + 공유 UI 컴포넌트
 *
 * 실제 토픽 목록 (geometry_msgs/Twist — TwistStamped 아님):
 *   /vicpinky/cmd_vel           geometry_msgs/Twist
 *   /vicpinky/joint_states      sensor_msgs/JointState
 *   /vicpinky/odom              nav_msgs/Odometry
 *   /vicpinky/polygon           geometry_msgs/PolygonStamped
 *   /vicpinky/robot_description std_msgs/String
 *   /vicpinky/scan              sensor_msgs/LaserScan
 *   /vicpinky/scan_filtered     sensor_msgs/LaserScan
 *   /vicpinky/laser_scan_polygon_filter/transition_event  lifecycle_msgs/TransitionEvent
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { PanelProps } from "../../hooks/useRos";
import ActionPanel from "../ActionPanel";
import RampControl from "../RampControl";
import LidarCanvas from "../explore/LidarCanvas";
import { useKeyboardControl } from "../../hooks/useKeyboardControl";
import type {
  RosMessage,
  ActionGoalPayload,
  ActionFeedback,
  ActionResult,
  ActiveGoals,
  CmdVelPayload,
} from "../../hooks/useNestSocket";

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const r2d = (r: number) => (r * 180) / Math.PI;
const f   = (n: number, d = 2) => n.toFixed(d);

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y ** 2 + q.z ** 2));
}

type DiagStatus = "idle" | "loading" | "ok" | "error";

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props extends PanelProps {
  rosMessages: Record<string, RosMessage>;
  emitCmdVel: (payload: CmdVelPayload) => void;
  emitAction: (payload: ActionGoalPayload) => void;
  cancelAction: (actionName: string, goalId: string) => void;
  activeGoals: ActiveGoals;
  actionFeedbacks: Record<string, ActionFeedback>;
  actionResults: Record<string, ActionResult>;
  callService: (serviceName: string, serviceType: string, request: Record<string, unknown>, callback: (res: unknown) => void) => void;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
export default function VicPinkyPanel({
  rosMessages, emitCmdVel,
  emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
  callService,
}: Props) {
  const [scanTab, setScanTab]           = useState<"scan" | "scan_filtered">("scan");
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [diagStatus, setDiagStatus]     = useState<DiagStatus>("idle");
  const diagTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // rosMessages에서 데이터 추출
  const p = (topic: string) => rosMessages[`/vicpinky/${topic}`]?.data;

  // ── odom ──────────────────────────────────────────────────────────────────
  const odomData = p("odom") as {
    pose?: { pose?: { position?: { x?: number; y?: number };
                      orientation?: { x?: number; y?: number; z?: number; w?: number } } };
    twist?: { twist?: { linear?: { x?: number }; angular?: { z?: number } } };
  } | undefined;
  const odomPos = odomData?.pose?.pose?.position;
  const odomOri = odomData?.pose?.pose?.orientation;
  const odomYaw = odomOri ? r2d(quatToYaw(odomOri as { x:number; y:number; z:number; w:number })) : null;
  const odomV   = odomData?.twist?.twist?.linear?.x  ?? null;
  const odomW   = odomData?.twist?.twist?.angular?.z ?? null;

  // ── cmd_vel 수신 (Twist — TwistStamped 아님) ──────────────────────────────
  const cvData    = p("cmd_vel") as { linear?: { x?: number }; angular?: { z?: number } } | undefined;
  const cvLinear  = cvData?.linear?.x  ?? null;
  const cvAngular = cvData?.angular?.z ?? null;

  // ── joint_states ──────────────────────────────────────────────────────────
  const jsData   = p("joint_states") as { name?: string[]; position?: number[]; velocity?: number[] } | undefined;
  const jsNames  = jsData?.name ?? [];

  // ── scan (raw + filtered) ─────────────────────────────────────────────────
  const scanRaw      = p("scan") as { angle_min?:number; angle_increment?:number; range_min?:number; range_max?:number; ranges?:number[] } | undefined;
  const scanFiltered = p("scan_filtered") as typeof scanRaw;
  const activeScan   = scanTab === "scan" ? scanRaw : scanFiltered;
  const rMin         = activeScan?.range_min ?? 0.12;
  const rMax         = activeScan?.range_max ?? 3.5;
  const validRanges  = (activeScan?.ranges ?? []).filter(r => isFinite(r) && r >= rMin && r <= rMax);
  const nearest      = validRanges.length ? Math.min(...validRanges) : null;

  // ── polygon ───────────────────────────────────────────────────────────────
  const polyData   = p("polygon") as { polygon?: { points?: { x:number; y:number; z:number }[] } } | undefined;
  const polyPoints = polyData?.polygon?.points ?? [];

  // ── robot_description ─────────────────────────────────────────────────────
  const rdReceived = p("robot_description") != null;

  // ── lifecycle transition_event ────────────────────────────────────────────
  const lcData = p("laser_scan_polygon_filter/transition_event") as {
    transition?: { label?: string };
    start_state?: { label?: string };
    goal_state?:  { label?: string };
  } | undefined;

  // ── 키보드 조종 ──────────────────────────────────────────────────────────
  const handleCmdVel = useCallback((payload: CmdVelPayload) => emitCmdVel(payload), [emitCmdVel]);
  useKeyboardControl({ botId: "vicpinky", enabled: keyboardActive, publish: handleCmdVel, linearSpeed: 0.3, angularSpeed: 1.0 });
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setKeyboardActive(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  // ── 자가진단 ─────────────────────────────────────────────────────────────
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
    <div className="max-w-2xl">
      <PanelCard title="VicPinky" icon="🚛" accent="amber" badge="vicpinky">

        {/* ── 2열 센서 그리드 ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4">

          {/* Odometry */}
          <SensorBox label="Odometry">
            {odomPos ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="X"   value={`${f(odomPos.x ?? 0, 3)} m`} />
                  <TRow label="Y"   value={`${f(odomPos.y ?? 0, 3)} m`} />
                  <TRow label="Yaw" value={odomYaw != null ? `${f(odomYaw, 1)}°` : "—"} />
                  <TRow label="v"   value={odomV   != null ? `${f(odomV,   3)} m/s` : "—"} />
                  <TRow label="ω"   value={odomW   != null ? `${f(odomW,   3)} rad/s` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorBox>

          {/* Joint States */}
          <SensorBox label="Joint States">
            {jsData ? (
              <table className="w-full text-xs">
                <tbody>
                  {jsNames.length > 0 ? jsNames.map((name, i) => (
                    <TRow key={name}
                      label={name.length > 18 ? name.slice(-18) : name}
                      value={`vel ${f(jsData.velocity?.[i] ?? 0, 3)} r/s`}
                    />
                  )) : <tr><td colSpan={2}><NoData /></td></tr>}
                </tbody>
              </table>
            ) : <NoData />}
          </SensorBox>

          {/* Polygon Footprint */}
          <SensorBox label="Polygon Footprint">
            {polyPoints.length > 0 ? (
              <div className="text-xs space-y-1">
                <p className="text-slate-400">
                  포인트 수: <span className="text-white font-mono font-bold">{polyPoints.length}</span>
                </p>
                <div className="max-h-20 overflow-y-auto space-y-0.5">
                  {polyPoints.slice(0, 6).map((pt, i) => (
                    <p key={i} className="font-mono text-slate-400 text-[10px]">
                      [{i}] ({f(pt.x, 3)}, {f(pt.y, 3)})
                    </p>
                  ))}
                  {polyPoints.length > 6 && (
                    <p className="text-slate-600 text-[10px]">+{polyPoints.length - 6}개 더…</p>
                  )}
                </div>
              </div>
            ) : <NoData />}
          </SensorBox>

          {/* Lifecycle + robot_description */}
          <SensorBox label="노드 상태">
            <table className="w-full text-xs">
              <tbody>
                <TRow
                  label="필터 노드"
                  value={lcData?.goal_state?.label ?? "—"}
                />
                <TRow
                  label="전이"
                  value={lcData?.transition?.label ?? "—"}
                />
                <TRow
                  label="이전 상태"
                  value={lcData?.start_state?.label ?? "—"}
                />
                <TRow
                  label="URDF"
                  value={rdReceived ? "✓ 수신됨" : "대기 중…"}
                />
              </tbody>
            </table>
          </SensorBox>
        </div>

        {/* ── LIDAR (raw / filtered 탭) ─────────────────────────────────── */}
        <Section label="LIDAR Scan">
          {/* 탭 */}
          <div className="flex gap-1 mb-3">
            {(["scan", "scan_filtered"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setScanTab(tab)}
                className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-widest transition-all border ${
                  scanTab === tab
                    ? "border-red-800/60 bg-red-950/30 text-red-400"
                    : "border-[#222222] bg-transparent text-[#333333] hover:text-[#666666]"
                }`}
              >
                {tab === "scan" ? "RAW" : "FILTERED"}
              </button>
            ))}
            {nearest !== null && (
              <span className={`ml-auto text-[10px] font-mono font-bold px-2 py-1 border ${
                nearest < 0.3
                  ? "text-red-500 border-red-800/50 bg-red-950/20 danger-pulse"
                  : "text-[#666666] border-[#222222]"
              }`}>
                최근접 {nearest.toFixed(2)} m
              </span>
            )}
          </div>

          <div className="flex gap-4 items-start">
            {/* LiDAR Canvas */}
            <div className="bg-[#050505] border border-red-900/30 p-1.5 shadow-inner shadow-black/60">
              <LidarCanvas scanData={activeScan} size={240} />
            </div>

            {/* 스캔 요약 */}
            <div className="flex-1 space-y-1.5">
              <p className="text-[9px] text-[#444444] uppercase tracking-[0.2em] font-mono mb-2">
                {scanTab === "scan" ? "원시 스캔" : "필터 스캔"}
              </p>
              {activeScan ? (
                <>
                  <DataRow label="총 포인트" value={`${activeScan.ranges?.length ?? 0}`} />
                  <DataRow label="유효 포인트" value={`${validRanges.length}`} />
                  <DataRow label="range_min" value={`${f(activeScan.range_min ?? 0)} m`} />
                  <DataRow label="range_max" value={`${f(activeScan.range_max ?? 0)} m`} />
                  <DataRow label="최근접" value={nearest != null ? `${f(nearest)} m` : "—"}
                    alert={nearest != null && nearest < 0.3} />
                </>
              ) : (
                <p className="text-[11px] text-[#2a2a2a] font-mono">NO DATA</p>
              )}
            </div>
          </div>
        </Section>

        {/* ── cmd_vel 수신 표시 (Twist) ────────────────────────────────── */}
        <Section label="cmd_vel 수신 (geometry_msgs/Twist)">
          {cvLinear !== null ? (
            <div className="grid grid-cols-2 gap-2">
              <VelDisplay label="linear.x"  value={cvLinear}  unit="m/s" />
              <VelDisplay label="angular.z" value={cvAngular} unit="rad/s" />
            </div>
          ) : <NoData />}
        </Section>

        {/* ── 키보드 조종 ────────────────────────────────────────────────── */}
        <Section label="키보드 조종 (cmd_vel 발행)">
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setKeyboardActive(v => !v)}
              className={`w-full py-2.5 text-[11px] font-black uppercase tracking-[0.2em] transition-all border ${
                keyboardActive
                  ? "border-green-800/60 bg-green-950/30 text-green-500"
                  : "border-[#222222] bg-transparent text-[#444444] hover:border-red-900/40 hover:text-[#888888]"
              }`}
            >
              {keyboardActive ? "◉ 조종 활성 — ESC 비활성" : "◎ 키보드 조종 시작"}
            </button>
            {keyboardActive && (
              <>
                <div className="grid grid-cols-3 gap-1 w-fit mx-auto">
                  <div /><KeyCap label="W" sub="전진" /><div />
                  <KeyCap label="A" sub="좌" />
                  <KeyCap label="S" sub="후진" />
                  <KeyCap label="D" sub="우" />
                </div>
                <p className="text-[9px] text-[#333333] text-center font-mono uppercase tracking-widest">
                  linear 0.3 m/s · angular 1.0 rad/s
                </p>
              </>
            )}
          </div>
        </Section>

        {/* ── 자가진단 ─────────────────────────────────────────────────── */}
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

        {/* ── 램프 제어 (RampControl 액션 + ramp_state 토픽) ───────────── */}
        <Section label="램프 제어 (RampControl)">
          <RampControl
            emitAction={emitAction}
            cancelAction={cancelAction}
            activeGoals={activeGoals}
            actionFeedbacks={actionFeedbacks}
            actionResults={actionResults}
            rampState={p("ramp_state") as { ramp_state?: string; ramp_angle?: string } | undefined}
          />
        </Section>

        {/* ── Action ─────────────────────────────────────────────────────── */}
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

// ── 서브 컴포넌트 (VicPinky 전용) ────────────────────────────────────────────

function SensorBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[9px] font-bold text-[#444444] uppercase tracking-[0.25em]">{label}</p>
      <div className="bg-[#0a0a0a] p-3 border border-[#1e1e1e] h-full">{children}</div>
    </div>
  );
}

function TRow({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <tr>
      <td className="text-[#444444] font-mono py-0.5 pr-2 whitespace-nowrap text-[10px]">{label}</td>
      <td className={`font-mono text-right text-[10px] ${
        alert ? "text-red-500 font-black danger-pulse" : "text-[#c0c0c0]"
      }`}>{value}</td>
    </tr>
  );
}

function DataRow({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex justify-between items-center text-[10px]">
      <span className="text-[#444444] font-mono">{label}</span>
      <span className={`font-mono ${alert ? "text-red-500 font-black" : "text-[#c0c0c0]"}`}>{value}</span>
    </div>
  );
}

function VelDisplay({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  const v = value ?? 0;
  const color = v > 0.001 ? "text-green-600" : v < -0.001 ? "text-red-500" : "text-[#444444]";
  return (
    <div className="bg-[#080808] border border-[#1e1e1e] px-3 py-2 flex flex-col gap-0.5">
      <span className="text-[9px] text-[#333333] uppercase tracking-widest font-mono">{label}</span>
      <span className={`text-lg font-mono font-black tabular-nums ${color}`}>
        {v >= 0 ? "+" : ""}{v.toFixed(3)}
        <span className="text-[10px] text-[#333333] ml-1">{unit}</span>
      </span>
    </div>
  );
}

function KeyCap({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-10 h-10 bg-[#0a0a0a] border border-red-900/50 flex items-center
                      justify-center font-black text-[#c0c0c0] text-sm font-mono shadow shadow-black/60">
        {label}
      </div>
      <span className="text-[#333333] text-[9px] font-mono uppercase">{sub}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 공유 UI 컴포넌트 — 재난 테마 (검정·은색·빨강)
// ══════════════════════════════════════════════════════════════════════════════

export function PanelCard({
  title, icon, accent = "blue", badge, children,
}: {
  title: string; icon: string;
  accent?: "amber" | "blue" | "orange";
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[#0d0d0d] border border-red-900/40 rounded-none p-5 flex flex-col gap-4
                    shadow-2xl shadow-black/80 border-glow-red">
      <div className="flex items-center justify-between border-b border-red-900/30 pb-3">
        <h2 className="text-sm font-black text-[#c0c0c0] uppercase tracking-[0.2em] flex items-center gap-2">
          <span className="text-red-600 text-base">{icon}</span>
          {title}
        </h2>
        {badge && (
          <span className="text-[9px] font-mono font-bold px-2 py-0.5 border border-red-900/50
                           bg-red-950/20 text-red-600 tracking-[0.2em] uppercase">
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-red-700/60 text-[8px]">◆</span>
        <p className="text-[9px] font-bold text-[#444444] uppercase tracking-[0.25em]">{label}</p>
        <div className="flex-1 h-px bg-red-900/20" />
      </div>
      <div className="bg-[#0a0a0a] p-3 border border-[#1e1e1e]">{children}</div>
    </div>
  );
}

export function BigStatus({ value, color }: { value: string; color: string }) {
  return (
    <span className={`text-xl font-black uppercase tracking-widest font-mono ${color}`}>{value}</span>
  );
}

export function BatteryBar({ pct }: { pct: number }) {
  const fill = pct < 20 ? "bg-red-700" : pct < 50 ? "bg-[#666666]" : "bg-green-700";
  const text = pct < 20 ? "text-red-500" : pct < 50 ? "text-[#888888]" : "text-green-600";
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1.5 bg-[#1a1a1a] overflow-hidden border border-[#2a2a2a]">
        <div className={`h-full transition-all ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-black tabular-nums font-mono w-10 text-right ${text}`}>{pct}%</span>
    </div>
  );
}

export function GoldButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="px-4 py-1.5 border border-red-800/60 bg-red-950/30 hover:bg-red-900/50
                 text-red-400 text-[11px] font-bold uppercase tracking-widest transition-all
                 hover:border-red-700/80 hover:text-red-300">
      {children}
    </button>
  );
}

export function BlueButton({ onClick, children, disabled = false }: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-1.5 border text-[11px] font-bold uppercase tracking-widest transition-all ${
        disabled
          ? "border-[#1a1a1a] bg-transparent text-[#333333] cursor-not-allowed"
          : "border-[#2a2a2a] bg-[#111111] hover:bg-[#1a1a1a] text-[#888888] hover:border-[#444444] hover:text-[#c0c0c0]"
      }`}
    >
      {children}
    </button>
  );
}

export function DangerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="px-4 py-1.5 border border-red-700/70 bg-red-900/40 hover:bg-red-800/60
                 text-red-300 text-[11px] font-bold uppercase tracking-widest transition-all
                 hover:border-red-600 hover:text-red-200">
      {children}
    </button>
  );
}

export function NoData() {
  return <span className="text-[11px] text-[#2a2a2a] font-mono tracking-widest">NO DATA</span>;
}
