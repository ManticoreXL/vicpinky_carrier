import { useEffect, useState, useCallback } from "react";
import { PanelProps } from "../../hooks/useRos";
import {
  RosMessage, CmdVelPayload,
  ActionGoalPayload, ActionFeedback, ActionResult, ActiveGoals,
} from "../../hooks/useNestSocket";
import {
  PanelCard, Section, BigStatus,
  GoldButton, BlueButton, DangerButton, NoData,
} from "./BigPinkyPanel";
import { useKeyboardControl } from "../../hooks/useKeyboardControl";
import ActionPanel from "../ActionPanel";

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}
function quatToRoll(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
}
function quatToPitch(q: { x: number; y: number; z: number; w: number }) {
  return Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
}
const r2d = (r: number) => (r * 180) / Math.PI;
const f   = (n: number, d = 2) => n.toFixed(d);

// ── 타입 ──────────────────────────────────────────────────────────────────────

const BOT_LABELS: Record<string, string> = {
  tb3_01: "터틀봇 1",
  tb3_02: "터틀봇 2",
  tb3_03: "터틀봇 3",
  tb3_04: "터틀봇 4",
};

interface Props extends PanelProps {
  botId: string;
  emitCmdVel: (payload: CmdVelPayload) => void;
  rosMessages: Record<string, RosMessage>;
  emitAction: (payload: ActionGoalPayload) => void;
  cancelAction: (actionName: string, goalId: string) => void;
  activeGoals: ActiveGoals;
  actionFeedbacks: Record<string, ActionFeedback>;
  actionResults: Record<string, ActionResult>;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function TurtlebotPanel({
  subscribe, publish, botId, emitCmdVel, rosMessages,
  emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
}: Props) {
  const [mode, setMode]               = useState("unknown");
  const [detected, setDetected]       = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);

  // ── 직접 roslibjs 구독 (mode, yolo) ─────────────────────────────────────
  useEffect(() => {
    const subs = [
      subscribe<{ data: string }>(`/${botId}/mode`, "std_msgs/String",
        (m) => setMode(m.data)),
      subscribe<{ data: boolean }>(`/${botId}/yolo/person_detected`, "std_msgs/Bool",
        (m) => setDetected(m.data)),
    ];
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe, botId]);

  // ── NestJS rosMessages에서 센서 데이터 추출 ──────────────────────────────
  const p = (topic: string) => rosMessages[`/${botId}/${topic}`]?.data;

  // cmd_vel
  const cvData  = p("cmd_vel") as { linear?: { x?: number }; angular?: { z?: number } } | undefined;
  const cvLinear  = cvData?.linear?.x  ?? null;
  const cvAngular = cvData?.angular?.z ?? null;

  // battery_state
  const batData = p("battery_state") as { voltage?: number; percentage?: number; current?: number } | undefined;
  const batPct  = batData?.percentage != null ? Math.round(batData.percentage * 100) : null;
  const batV    = batData?.voltage ?? null;
  const batA    = batData?.current ?? null;

  // odom
  const odomData = p("odom") as {
    pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } };
    twist?: { twist?: { linear?: { x?: number }; angular?: { z?: number } } };
  } | undefined;
  const odomPos = odomData?.pose?.pose?.position;
  const odomOri = odomData?.pose?.pose?.orientation;
  const odomYaw = odomOri ? r2d(quatToYaw(odomOri as { x: number; y: number; z: number; w: number })) : null;
  const odomV   = odomData?.twist?.twist?.linear?.x  ?? null;
  const odomW   = odomData?.twist?.twist?.angular?.z ?? null;

  // imu
  const imuData = p("imu") as {
    orientation?: { x?: number; y?: number; z?: number; w?: number };
    angular_velocity?: { x?: number; y?: number; z?: number };
    linear_acceleration?: { x?: number; y?: number; z?: number };
  } | undefined;
  const imuOri = imuData?.orientation;
  const imuRoll  = imuOri ? r2d(quatToRoll(imuOri  as { x: number; y: number; z: number; w: number })) : null;
  const imuPitch = imuOri ? r2d(quatToPitch(imuOri as { x: number; y: number; z: number; w: number })) : null;
  const imuYaw   = imuOri ? r2d(quatToYaw(imuOri   as { x: number; y: number; z: number; w: number })) : null;
  const imuAV = imuData?.angular_velocity;
  const imuLA = imuData?.linear_acceleration;

  // joint_states
  const jsData = p("joint_states") as {
    name?: string[];
    position?: number[];
    velocity?: number[];
  } | undefined;
  const jsNames = jsData?.name ?? [];
  const jsLIdx  = jsNames.indexOf("wheel_left_joint");
  const jsRIdx  = jsNames.indexOf("wheel_right_joint");
  const jsLVel  = jsLIdx >= 0 ? jsData?.velocity?.[jsLIdx] ?? null : null;
  const jsRVel  = jsRIdx >= 0 ? jsData?.velocity?.[jsRIdx] ?? null : null;
  const jsLPos  = jsLIdx >= 0 ? jsData?.position?.[jsLIdx] ?? null : null;
  const jsRPos  = jsRIdx >= 0 ? jsData?.position?.[jsRIdx] ?? null : null;

  // magnetic_field
  const magData = p("magnetic_field") as { magnetic_field?: { x?: number; y?: number; z?: number } } | undefined;
  const mag = magData?.magnetic_field;
  const magHdg = mag?.x != null && mag?.y != null
    ? ((Math.atan2(mag.y, mag.x) * 180) / Math.PI + 360) % 360
    : null;

  // scan
  const scanData = p("scan") as {
    range_min?: number;
    range_max?: number;
    ranges?: number[];
  } | undefined;
  const rawRanges   = scanData?.ranges ?? [];
  const validRanges = rawRanges.filter((r) => isFinite(r) && r > 0);
  const scanNearest = validRanges.length > 0 ? Math.min(...validRanges) : null;
  const scanTotal   = rawRanges.length;
  const scanValid   = validRanges.length;

  // sensor_state
  const ssData = p("sensor_state") as {
    bumper?: number;
    cliff?: number;
    left_encoder?: number;
    right_encoder?: number;
    battery?: number;
  } | undefined;

  // robot_description
  const rdReceived = p("robot_description") != null;

  // ── 키보드 조종 ──────────────────────────────────────────────────────────
  const handleCmdVel = useCallback((payload: CmdVelPayload) => emitCmdVel(payload), [emitCmdVel]);
  useKeyboardControl({ botId, enabled: keyboardActive, publish: handleCmdVel, linearSpeed: 0.2, angularSpeed: 1.0 });

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setKeyboardActive(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  const modeColor =
    mode === "explore" ? "text-blue-400" :
    mode === "deliver" ? "text-amber-400" :
    mode === "stop"    ? "text-red-400"  : "text-blue-400/40";

  return (
    <div className="max-w-2xl">
      <PanelCard title={BOT_LABELS[botId] ?? botId} icon="🤖" accent="blue" badge={botId}>

        {/* ── 모드 제어 ──────────────────────────────────────────────────── */}
        <Section label="현재 모드">
          <div className="flex items-center justify-between gap-4">
            <BigStatus value={mode} color={modeColor} />
            <div className="flex gap-2">
              <BlueButton   onClick={() => publish(`/${botId}/cmd`, "std_msgs/String", { data: "explore" })}>탐사</BlueButton>
              <GoldButton   onClick={() => publish(`/${botId}/cmd`, "std_msgs/String", { data: "deliver" })}>수송</GoldButton>
              <DangerButton onClick={() => publish(`/${botId}/cmd`, "std_msgs/String", { data: "stop" })}>정지</DangerButton>
            </div>
          </div>
        </Section>

        {/* ── 센서 그리드 (2열) ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4">

          {/* Odometry */}
          <SensorCard label="Odometry">
            {odomPos ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="X"   value={`${f(odomPos.x ?? 0)} m`} />
                  <TRow label="Y"   value={`${f(odomPos.y ?? 0)} m`} />
                  <TRow label="Yaw" value={odomYaw != null ? `${f(odomYaw, 1)}°` : "—"} />
                  <TRow label="v"   value={odomV != null ? `${f(odomV, 3)} m/s` : "—"} />
                  <TRow label="ω"   value={odomW != null ? `${f(odomW, 3)} rad/s` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

          {/* IMU */}
          <SensorCard label="IMU">
            {imuOri ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="Roll"  value={imuRoll  != null ? `${f(imuRoll,  1)}°` : "—"} />
                  <TRow label="Pitch" value={imuPitch != null ? `${f(imuPitch, 1)}°` : "—"} />
                  <TRow label="Yaw"   value={imuYaw   != null ? `${f(imuYaw,   1)}°` : "—"} />
                  {imuAV && <TRow label="ω.z" value={`${f(imuAV.z ?? 0, 3)} r/s`} />}
                  {imuLA && <TRow label="a.x" value={`${f(imuLA.x ?? 0, 3)} m/s²`} />}
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

          {/* Joint States */}
          <SensorCard label="Joint States">
            {jsData ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="L vel"  value={jsLVel != null ? `${f(jsLVel, 3)} r/s` : "—"} />
                  <TRow label="R vel"  value={jsRVel != null ? `${f(jsRVel, 3)} r/s` : "—"} />
                  <TRow label="L pos"  value={jsLPos != null ? `${f(r2d(jsLPos), 1)}°` : "—"} />
                  <TRow label="R pos"  value={jsRPos != null ? `${f(r2d(jsRPos), 1)}°` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

          {/* Magnetic Field */}
          <SensorCard label="Magnetic Field">
            {mag ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="X"   value={`${f((mag.x ?? 0) * 1e6, 2)} μT`} />
                  <TRow label="Y"   value={`${f((mag.y ?? 0) * 1e6, 2)} μT`} />
                  <TRow label="Z"   value={`${f((mag.z ?? 0) * 1e6, 2)} μT`} />
                  <TRow label="Hdg" value={magHdg != null ? `${f(magHdg, 1)}°` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

          {/* LIDAR Scan */}
          <SensorCard label="LIDAR Scan">
            {scanData ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="최근접"   value={scanNearest != null ? `${f(scanNearest)} m` : "—"} highlight={scanNearest != null && scanNearest < 0.3} />
                  <TRow label="유효점"   value={`${scanValid} / ${scanTotal}`} />
                  <TRow label="범위 min" value={scanData.range_min != null ? `${f(scanData.range_min)} m` : "—"} />
                  <TRow label="범위 max" value={scanData.range_max != null ? `${f(scanData.range_max)} m` : "—"} />
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

          {/* Sensor State */}
          <SensorCard label="Sensor State">
            {ssData ? (
              <table className="w-full text-xs">
                <tbody>
                  <TRow label="Bumper"  value={ssData.bumper ? `⚠ ${ssData.bumper}` : "○ 없음"} highlight={!!ssData.bumper} />
                  <TRow label="Cliff"   value={ssData.cliff  ? "⚠ 감지"               : "○ 없음"} highlight={!!ssData.cliff} />
                  <TRow label="L-Enc"  value={String(ssData.left_encoder  ?? "—")} />
                  <TRow label="R-Enc"  value={String(ssData.right_encoder ?? "—")} />
                  {ssData.battery != null && <TRow label="센서 전압" value={`${f(ssData.battery, 1)} V`} />}
                </tbody>
              </table>
            ) : <NoData />}
          </SensorCard>

        </div>{/* /grid */}

        {/* ── 배터리 ──────────────────────────────────────────────────────── */}
        <Section label="배터리 (battery_state)">
          {batData ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-blue-950 rounded-full overflow-hidden border border-blue-900/60">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (batPct ?? 0) < 20 ? "bg-red-500" : (batPct ?? 0) < 50 ? "bg-amber-500" : "bg-green-500"
                    }`}
                    style={{ width: `${batPct ?? 0}%` }}
                  />
                </div>
                <span className={`text-sm font-bold tabular-nums w-10 text-right ${
                  (batPct ?? 0) < 20 ? "text-red-400" : (batPct ?? 0) < 50 ? "text-amber-400" : "text-green-400"
                }`}>{batPct ?? "—"}%</span>
              </div>
              <div className="flex gap-4 text-xs text-gray-400">
                {batV != null && <span>전압 <span className="text-white font-mono">{f(batV, 2)} V</span></span>}
                {batA != null && <span>전류 <span className="text-white font-mono">{f(batA, 2)} A</span></span>}
              </div>
            </div>
          ) : <NoData />}
        </Section>

        {/* ── cmd_vel 수신 ────────────────────────────────────────────────── */}
        <Section label="cmd_vel 수신">
          {cvLinear !== null ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <VelDisplay label="linear.x"  value={cvLinear}  unit="m/s" />
                <VelDisplay label="angular.z" value={cvAngular} unit="rad/s" />
              </div>
              <p className="text-[10px] text-gray-600 text-right">
                {new Date(rosMessages[`/${botId}/cmd_vel`]?.timestamp ?? 0).toLocaleTimeString()}
              </p>
            </div>
          ) : <NoData />}
        </Section>

        {/* ── 키보드 조종 ─────────────────────────────────────────────────── */}
        <Section label="키보드 조종">
          <div className="flex flex-col gap-3">
            <button
              onClick={() => setKeyboardActive((v) => !v)}
              className={`w-full py-2 rounded-lg text-sm font-semibold transition-colors ${
                keyboardActive
                  ? "bg-green-600 hover:bg-green-500 text-white"
                  : "bg-gray-700 hover:bg-gray-600 text-gray-300"
              }`}
            >
              {keyboardActive ? "🟢 조종 활성 (ESC로 비활성)" : "⚫ 키보드 조종 시작"}
            </button>
            {keyboardActive && (
              <>
                <div className="grid grid-cols-3 gap-1 w-fit mx-auto text-xs text-center select-none">
                  <div /><KeyCap label="W" sub="전진" /><div />
                  <KeyCap label="A" sub="좌회전" />
                  <KeyCap label="S" sub="후진" />
                  <KeyCap label="D" sub="우회전" />
                </div>
                <p className="text-xs text-gray-500 text-center">
                  누르는 동안 이동 · 떼면 정지 · 0.2 m/s · 1.0 rad/s
                </p>
              </>
            )}
          </div>
        </Section>

        {/* ── YOLO 감지 ───────────────────────────────────────────────────── */}
        <Section label="YOLO 감지">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-colors ${
              detected ? "bg-yellow-400 shadow-md shadow-yellow-400/50 animate-pulse" : "bg-blue-900"
            }`} />
            <span className={`text-sm font-semibold ${detected ? "text-yellow-400" : "text-blue-400/40"}`}>
              {detected ? "사람 감지됨" : "미감지"}
            </span>
          </div>
        </Section>

        {/* ── URDF 수신 여부 ──────────────────────────────────────────────── */}
        <Section label="robot_description">
          <span className={`text-sm font-semibold ${rdReceived ? "text-green-400" : "text-blue-400/30"}`}>
            {rdReceived ? "✓ URDF 수신됨" : "대기 중…"}
          </span>
        </Section>

        {/* ── Action ──────────────────────────────────────────────────────── */}
        <ActionPanel
          robotNamespace={botId}
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

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function SensorCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold text-amber-400/50 uppercase tracking-widest">{label}</p>
      <div className="bg-[#020e25] rounded-xl p-3 border border-blue-900/60 h-full">
        {children}
      </div>
    </div>
  );
}

function TRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <tr>
      <td className="text-blue-300/50 py-0.5 pr-2 whitespace-nowrap">{label}</td>
      <td className={`font-mono text-right ${highlight ? "text-red-400 font-bold" : "text-blue-100"}`}>{value}</td>
    </tr>
  );
}

function VelDisplay({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  const v = value ?? 0;
  const color = v > 0.001 ? "text-green-400" : v < -0.001 ? "text-red-400" : "text-gray-400";
  return (
    <div className="bg-gray-900 rounded-lg px-3 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
      <span className={`text-lg font-mono font-bold ${color}`}>
        {v >= 0 ? "+" : ""}{v.toFixed(3)}
        <span className="text-xs text-gray-500 ml-1">{unit}</span>
      </span>
    </div>
  );
}

function KeyCap({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-10 h-10 bg-gray-700 border border-gray-600 rounded-md flex items-center justify-center font-bold text-white text-sm shadow">
        {label}
      </div>
      <span className="text-gray-500 text-[10px]">{sub}</span>
    </div>
  );
}
