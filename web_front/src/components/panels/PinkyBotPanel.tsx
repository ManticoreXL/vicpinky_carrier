/**
 * PinkyBot 전용 패널
 *
 * 실제 토픽 (네임스페이스 없음):
 *   /battery/percent    std_msgs/Float32
 *   /battery/voltage    std_msgs/Float32
 *   /cmd_vel            geometry_msgs/Twist
 *   /joint_states       sensor_msgs/JointState
 *   /odom               nav_msgs/Odometry
 *   /robot_description  std_msgs/String
 *   /scan               sensor_msgs/LaserScan
 *
 * 서비스:
 *   /start_motor        std_srvs/Empty
 *   /stop_motor         std_srvs/Empty
 */

import { useState, useCallback, useEffect } from "react";
import type { RosMessage, CmdVelPayload } from "../../hooks/useNestSocket";
import { useKeyboardControl } from "../../hooks/useKeyboardControl";
import LidarCanvas from "../explore/LidarCanvas";
import {
  PanelCard, Section, BatteryBar, NoData,
} from "./BigPinkyPanel";

// ── 유틸 ─────────────────────────────────────────────────────────────────────

const r2d = (r: number) => (r * 180) / Math.PI;
const f   = (n: number, d = 2) => n.toFixed(d);

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y ** 2 + q.z ** 2));
}

// ── 모터 상태 ─────────────────────────────────────────────────────────────────

type MotorState = "unknown" | "starting" | "running" | "stopping" | "stopped";

const MOTOR_STYLE: Record<MotorState, { dot: string; text: string; label: string }> = {
  unknown:  { dot: "bg-[#333]",                          text: "text-[#555]",       label: "UNKNOWN"   },
  starting: { dot: "bg-amber-400 animate-pulse",         text: "text-amber-400",    label: "STARTING…" },
  running:  { dot: "bg-green-500 animate-pulse",         text: "text-green-500",    label: "RUNNING"   },
  stopping: { dot: "bg-red-400 animate-pulse",           text: "text-red-400",      label: "STOPPING…" },
  stopped:  { dot: "bg-[#444]",                          text: "text-[#555]",       label: "STOPPED"   },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages: Record<string, RosMessage>;
  emitCmdVel:  (payload: CmdVelPayload) => void;
  callService: (
    serviceName: string,
    serviceType: string,
    request: Record<string, unknown>,
    callback: (res: unknown) => void,
  ) => void;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function PinkyBotPanel({ rosMessages, emitCmdVel, callService }: Props) {
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [motorState,     setMotorState]     = useState<MotorState>("unknown");
  const [svcLog,         setSvcLog]         = useState<string>("");

  // 루트 토픽 읽기 헬퍼
  const raw = (topic: string) => rosMessages[topic]?.data;

  // ── 배터리 ─────────────────────────────────────────────────────────────────
  const batPct  = (raw("/battery/percent")  as { data?: number } | undefined)?.data ?? null;
  const batVolt = (raw("/battery/voltage")  as { data?: number } | undefined)?.data ?? null;
  const batRound = batPct != null ? Math.round(batPct) : null;

  // ── Odometry ────────────────────────────────────────────────────────────────
  const odomData = raw("/odom") as {
    pose?: { pose?: {
      position?:    { x?: number; y?: number; z?: number };
      orientation?: { x?: number; y?: number; z?: number; w?: number };
    }};
    twist?: { twist?: {
      linear?:  { x?: number; y?: number };
      angular?: { z?: number };
    }};
  } | undefined;

  const odomPos = odomData?.pose?.pose?.position;
  const odomOri = odomData?.pose?.pose?.orientation;
  const odomYaw = odomOri
    ? r2d(quatToYaw(odomOri as { x:number; y:number; z:number; w:number }))
    : null;
  const odomV = odomData?.twist?.twist?.linear?.x  ?? null;
  const odomW = odomData?.twist?.twist?.angular?.z ?? null;

  // ── Joint States ────────────────────────────────────────────────────────────
  const jsData = raw("/joint_states") as {
    name?:     string[];
    position?: number[];
    velocity?: number[];
    effort?:   number[];
  } | undefined;
  const jsNames = jsData?.name ?? [];

  // ── LiDAR /scan ─────────────────────────────────────────────────────────────
  const scanData = raw("/scan") as {
    angle_min?:       number;
    angle_max?:       number;
    angle_increment?: number;
    range_min?:       number;
    range_max?:       number;
    ranges?:          number[];
  } | undefined;

  const rMin = scanData?.range_min ?? 0.12;
  const rMax = scanData?.range_max ?? 3.5;
  const validRanges = (scanData?.ranges ?? []).filter(r => isFinite(r) && r >= rMin && r <= rMax);
  const nearest = validRanges.length ? Math.min(...validRanges) : null;

  // ── CMD_VEL 수신 ────────────────────────────────────────────────────────────
  const cvData = raw("/cmd_vel") as {
    linear?:  { x?: number; y?: number };
    angular?: { z?: number };
  } | undefined;

  // ── 키보드 조종 ─────────────────────────────────────────────────────────────
  const handleCmdVel = useCallback((p: CmdVelPayload) => emitCmdVel(p), [emitCmdVel]);
  useKeyboardControl({
    botId: "pinky", enabled: keyboardActive,
    publish: handleCmdVel, linearSpeed: 0.3, angularSpeed: 1.0,
  });
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setKeyboardActive(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  // ── 서비스 호출 ─────────────────────────────────────────────────────────────
  const callMotor = useCallback((action: "start" | "stop") => {
    const svc  = action === "start" ? "/start_motor" : "/stop_motor";
    const next: MotorState = action === "start" ? "starting" : "stopping";
    const done: MotorState = action === "start" ? "running"  : "stopped";

    setMotorState(next);
    setSvcLog(`${svc} 호출 중…`);

    callService(svc, "std_srvs/srv/Empty", {}, () => {
      setMotorState(done);
      setSvcLog(`${svc} 완료 (${new Date().toLocaleTimeString("ko-KR")})`);
    });
  }, [callService]);

  const ms = MOTOR_STYLE[motorState];

  // ── URDF ────────────────────────────────────────────────────────────────────
  const rdRaw = raw("/robot_description") as string | { data?: string } | undefined;
  const rdReceived = rdRaw != null;

  return (
    <div className="max-w-2xl">
      <PanelCard title="Pinky" icon="🤖" accent="amber" badge="pinky">

        {/* ── 배터리 ─────────────────────────────────────────────────────── */}
        <Section label="배터리 (/battery/percent · /battery/voltage)">
          {batRound !== null ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest">충전량</span>
                <span className={`text-2xl font-black font-mono tabular-nums ${
                  batRound < 20 ? "text-red-500 danger-pulse" :
                  batRound < 50 ? "text-amber-400" : "text-green-500"
                }`}>{batRound}%</span>
              </div>
              <BatteryBar pct={batRound} />
              {batVolt !== null && (
                <div className="flex justify-between text-[10px] font-mono mt-2 border-t border-[#111] pt-2">
                  <span className="text-[#444]">전압</span>
                  <span className={`font-bold tabular-nums ${
                    batVolt < 10 ? "text-red-500" : batVolt < 11.5 ? "text-amber-400" : "text-[#888]"
                  }`}>{f(batVolt, 2)} V</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <NoData />
              <span className="text-[9px] font-mono text-[#333]">수신 대기: /battery/percent</span>
            </div>
          )}
        </Section>

        {/* ── 센서 2열 그리드 ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4">

          {/* Odometry */}
          <SensorBox label="Odometry (/odom)">
            {odomPos ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="X"   value={`${f(odomPos.x ?? 0, 3)} m`} />
                  <TRow label="Y"   value={`${f(odomPos.y ?? 0, 3)} m`} />
                  <TRow label="Yaw" value={odomYaw != null ? `${f(odomYaw, 1)}°` : "—"} />
                  <TRow label="v"   value={odomV != null ? `${f(odomV, 3)} m/s` : "—"}
                    color={odomV != null && Math.abs(odomV) > 0.01 ? "text-cyan-400" : undefined} />
                  <TRow label="ω"   value={odomW != null ? `${f(odomW, 3)} r/s` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorBox>

          {/* Joint States */}
          <SensorBox label="Joint States (/joint_states)">
            {jsData && jsNames.length > 0 ? (
              <div className="space-y-2">
                {jsNames.map((name, i) => {
                  const vel = jsData.velocity?.[i] ?? 0;
                  const pos = jsData.position?.[i] ?? 0;
                  const eff = jsData.effort?.[i];
                  const maxVel = 10;
                  const barW = Math.min(100, Math.abs(vel) / maxVel * 100);

                  return (
                    <div key={name}>
                      <div className="flex justify-between text-[9px] font-mono mb-0.5">
                        <span className="text-[#555] truncate max-w-[90px]" title={name}>
                          {name.length > 12 ? "…" + name.slice(-12) : name}
                        </span>
                        <span className="text-[#888]">{f(pos, 3)} r</span>
                      </div>
                      {/* 속도 바 */}
                      <div className="h-1 bg-[#111] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            Math.abs(vel) > maxVel * 0.8 ? "bg-red-600" :
                            Math.abs(vel) > maxVel * 0.4 ? "bg-amber-500" : "bg-blue-600"
                          }`}
                          style={{ width: `${barW}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[8px] font-mono text-[#333] mt-0.5">
                        <span>vel {f(vel, 2)} r/s</span>
                        {eff != null && <span>eff {f(eff, 2)} Nm</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-1">
                <NoData />
                {rdReceived && (
                  <p className="text-[8px] font-mono text-green-900">URDF 수신됨</p>
                )}
              </div>
            )}
          </SensorBox>
        </div>

        {/* ── LiDAR ──────────────────────────────────────────────────────── */}
        <Section label="LiDAR (/scan · SLAMTEC)">
          <div className="flex gap-4 items-start">
            <div className="bg-[#050505] border border-red-900/30 p-1.5 shadow-inner shadow-black/60">
              <LidarCanvas scanData={scanData} size={220} />
            </div>
            <div className="flex-1 space-y-1.5">
              {/* 최근접 경보 */}
              {nearest !== null && (
                <div className={`px-2 py-1 border text-[10px] font-mono font-bold mb-2 flex items-center gap-2 ${
                  nearest < 0.25
                    ? "border-red-800/70 bg-red-950/30 text-red-500 danger-pulse"
                    : nearest < 0.5
                    ? "border-amber-800/50 bg-amber-950/10 text-amber-400"
                    : "border-[#222] text-[#666]"
                }`}>
                  <span>{nearest < 0.25 ? "⚠" : "◎"}</span>
                  <span>최근접 {f(nearest)} m</span>
                </div>
              )}
              {scanData ? (
                <>
                  <DR label="총 포인트"    value={String(scanData.ranges?.length ?? 0)} />
                  <DR label="유효 포인트"  value={String(validRanges.length)} />
                  <DR label="range_min"    value={`${f(scanData.range_min ?? 0)} m`} />
                  <DR label="range_max"    value={`${f(scanData.range_max ?? 0)} m`} />
                  {scanData.angle_min != null && scanData.angle_max != null && (
                    <DR label="각도 범위" value={`${r2d(scanData.angle_min).toFixed(0)}° ~ ${r2d(scanData.angle_max).toFixed(0)}°`} />
                  )}
                </>
              ) : <NoData />}
            </div>
          </div>
        </Section>

        {/* ── CMD_VEL 수신 ───────────────────────────────────────────────── */}
        <Section label="cmd_vel 수신 (/cmd_vel)">
          {cvData ? (
            <div className="grid grid-cols-2 gap-3">
              <VelBox label="linear.x"  value={cvData.linear?.x  ?? null} unit="m/s"  />
              <VelBox label="angular.z" value={cvData.angular?.z ?? null} unit="r/s"  />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <NoData />
              <span className="text-[9px] font-mono text-[#333]">명령 없음</span>
            </div>
          )}
        </Section>

        {/* ── 모터 제어 ──────────────────────────────────────────────────── */}
        <Section label="모터 제어 (/start_motor · /stop_motor)">
          <div className="space-y-3">
            {/* 상태 표시 */}
            <div className="flex items-center gap-2.5 px-3 py-2 bg-[#080808] border border-[#1a1a1a]">
              <span className={`w-2 h-2 rounded-full flex-none ${ms.dot}`} />
              <span className={`text-[10px] font-black uppercase tracking-widest font-mono ${ms.text}`}>
                {ms.label}
              </span>
              {svcLog && (
                <span className="ml-auto text-[9px] font-mono text-[#333] truncate">{svcLog}</span>
              )}
            </div>

            {/* 버튼 2열 */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => callMotor("start")}
                disabled={motorState === "starting" || motorState === "running"}
                className={`py-3 border text-[11px] font-black uppercase tracking-[0.15em] transition-all flex flex-col items-center gap-1 ${
                  motorState === "running"
                    ? "border-green-800/60 bg-green-950/30 text-green-500 cursor-default"
                    : motorState === "starting"
                    ? "border-[#1a1a1a] text-[#333] cursor-not-allowed"
                    : "border-green-900/50 bg-[#0a0f0a] text-green-600 hover:bg-green-950/30 hover:border-green-700/60 hover:text-green-400"
                }`}
              >
                <span className="text-base">▶</span>
                <span>START MOTOR</span>
                <span className="text-[8px] text-[#444] font-normal font-mono">/start_motor</span>
              </button>

              <button
                onClick={() => callMotor("stop")}
                disabled={motorState === "stopping" || motorState === "stopped"}
                className={`py-3 border text-[11px] font-black uppercase tracking-[0.15em] transition-all flex flex-col items-center gap-1 ${
                  motorState === "stopped"
                    ? "border-[#1a1a1a] text-[#333] cursor-default"
                    : motorState === "stopping"
                    ? "border-[#1a1a1a] text-[#333] cursor-not-allowed"
                    : "border-red-800/60 bg-red-950/20 text-red-500 hover:bg-red-950/40 hover:border-red-700/60 hover:text-red-400"
                }`}
              >
                <span className="text-base">■</span>
                <span>STOP MOTOR</span>
                <span className="text-[8px] text-[#444] font-normal font-mono">/stop_motor</span>
              </button>
            </div>
          </div>
        </Section>

        {/* ── 키보드 조종 ────────────────────────────────────────────────── */}
        <Section label="키보드 조종 (cmd_vel 발행)">
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setKeyboardActive(v => !v)}
              className={`w-full py-2.5 text-[11px] font-black uppercase tracking-[0.2em] transition-all border ${
                keyboardActive
                  ? "border-green-800/60 bg-green-950/30 text-green-500"
                  : "border-[#222] bg-transparent text-[#444] hover:border-red-900/40 hover:text-[#888]"
              }`}
            >
              {keyboardActive ? "◉ 조종 활성 — ESC 비활성" : "◎ 키보드 조종 시작"}
            </button>

            {keyboardActive && (
              <div className="flex items-start gap-6">
                {/* WASD */}
                <div className="grid grid-cols-3 gap-1">
                  <div /><KeyCap label="W" sub="전진" /><div />
                  <KeyCap label="A" sub="좌" />
                  <KeyCap label="S" sub="후진" />
                  <KeyCap label="D" sub="우" />
                </div>
                {/* 실시간 cmd_vel */}
                <div className="flex-1 space-y-1.5 pt-1">
                  <p className="text-[9px] font-mono text-[#333] uppercase tracking-widest">실시간 명령</p>
                  <VelMini label="linear.x"  value={cvData?.linear?.x  ?? 0} unit="m/s" />
                  <VelMini label="angular.z" value={cvData?.angular?.z ?? 0} unit="r/s" />
                  <p className="text-[8px] font-mono text-[#222] mt-2">
                    0.3 m/s · 1.0 r/s
                  </p>
                </div>
              </div>
            )}
          </div>
        </Section>

      </PanelCard>
    </div>
  );
}

// ── 로컬 서브 컴포넌트 ────────────────────────────────────────────────────────

function SensorBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[9px] font-bold text-[#444] uppercase tracking-[0.25em]">{label}</p>
      <div className="bg-[#0a0a0a] p-3 border border-[#1e1e1e] h-full min-h-[100px]">{children}</div>
    </div>
  );
}

function TRow({
  label, value, color,
}: { label: string; value: string; color?: string }) {
  return (
    <tr>
      <td className="text-[#444] font-mono py-0.5 pr-2 whitespace-nowrap text-[10px]">{label}</td>
      <td className={`font-mono text-right text-[10px] ${color ?? "text-[#c0c0c0]"}`}>{value}</td>
    </tr>
  );
}

function DR({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-[10px]">
      <span className="text-[#444] font-mono">{label}</span>
      <span className="text-[#c0c0c0] font-mono">{value}</span>
    </div>
  );
}

function VelBox({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  const v = value ?? 0;
  const color = v > 0.01 ? "text-green-500" : v < -0.01 ? "text-red-500" : "text-[#444]";
  return (
    <div className="bg-[#080808] border border-[#1e1e1e] px-3 py-2.5 flex flex-col gap-0.5">
      <span className="text-[9px] text-[#333] uppercase tracking-widest font-mono">{label}</span>
      <span className={`text-xl font-mono font-black tabular-nums ${color}`}>
        {v >= 0 ? "+" : ""}{v.toFixed(3)}
        <span className="text-[10px] text-[#333] ml-1">{unit}</span>
      </span>
    </div>
  );
}

function VelMini({ label, value, unit }: { label: string; value: number; unit: string }) {
  const color = value > 0.01 ? "text-green-500" : value < -0.01 ? "text-red-500" : "text-[#333]";
  return (
    <div className="flex justify-between text-[10px] font-mono">
      <span className="text-[#333]">{label}</span>
      <span className={`font-bold tabular-nums ${color}`}>
        {value >= 0 ? "+" : ""}{value.toFixed(3)} {unit}
      </span>
    </div>
  );
}

function KeyCap({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-9 h-9 bg-[#0a0a0a] border border-red-900/50 flex items-center
                      justify-center font-black text-[#c0c0c0] text-sm font-mono shadow shadow-black/60">
        {label}
      </div>
      <span className="text-[#333] text-[8px] font-mono uppercase">{sub}</span>
    </div>
  );
}
