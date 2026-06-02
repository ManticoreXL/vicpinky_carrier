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

  // // cmd_vel
  // const cvData  = p("cmd_vel") as { linear?: { x?: number }; angular?: { z?: number } } | undefined;
  // const cvLinear  = cvData?.linear?.x  ?? null;
  // const cvAngular = cvData?.angular?.z ?? null;
  // 수정 (TwistStamped)
  const cvData = p("cmd_vel") as { twist?: { linear?: { x?: number }; angular?: { z?: number } } } | undefined;
  const cvLinear  = cvData?.twist?.linear?.x  ?? null;
  const cvAngular = cvData?.twist?.angular?.z ?? null;

  // battery_state — TB3 펌웨어는 percentage를 0~100으로 보냄 (ROS 스펙 0~1 아님)
  const batData = p("battery_state") as {
    voltage?: number; temperature?: number; current?: number;
    charge?: number; capacity?: number; design_capacity?: number;
    percentage?: number;
    power_supply_status?: number; power_supply_health?: number; power_supply_technology?: number;
    present?: boolean;
  } | undefined;
  const batPct = batData?.percentage != null
    ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
    : null;
  const batV = batData?.voltage ?? null;
  const batA = batData?.current ?? null;

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

  // scan — range_min/range_max 기준으로 유효 포인트 필터
  const scanData = p("scan") as {
    angle_min?: number; angle_max?: number; angle_increment?: number;
    range_min?: number; range_max?: number;
    ranges?: number[]; intensities?: number[];
  } | undefined;
  const rawRanges   = scanData?.ranges ?? [];
  const rMin = scanData?.range_min ?? 0;
  const rMax = scanData?.range_max ?? Infinity;
  const validRanges = rawRanges.filter((r) => isFinite(r) && r >= rMin && r <= rMax);
  const scanNearest = validRanges.length > 0 ? Math.min(...validRanges) : null;
  const scanTotal   = rawRanges.length;
  const scanValid   = validRanges.length;

  // sensor_state — turtlebot3_msgs/SensorState 전체 필드
  const ssData = p("sensor_state") as {
    bumper?: number;        // uint8: BUMPER_FORWARD=1, BUMPER_BACKWARD=2
    cliff?: number;         // float32: CLIFF=1 when detected
    sonar?: number;         // float32 (m)
    illumination?: number;  // float32
    led?: number;           // uint8
    button?: number;        // uint8: BUTTON0=1, BUTTON1=2
    torque?: boolean;       // bool
    left_encoder?: number;  // int32
    right_encoder?: number; // int32
    battery?: number;       // float32 (V)
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
                  <TRow label="Bumper" value={
                    ssData.bumper === 0 ? "○ 없음" :
                    ssData.bumper === 1 ? "⚠ 전방" :
                    ssData.bumper === 2 ? "⚠ 후방" :
                    ssData.bumper === 3 ? "⚠ 전+후" : "○ 없음"
                  } highlight={!!ssData.bumper} />
                  <TRow label="Cliff"  value={ssData.cliff ? "⚠ 감지" : "○ 없음"} highlight={!!ssData.cliff} />
                  {ssData.sonar != null     && <TRow label="Sonar"  value={`${f(ssData.sonar, 2)} m`} />}
                  {ssData.button != null    && <TRow label="Button" value={ssData.button === 0 ? "—" : `B${ssData.button}`} />}
                  {ssData.torque != null    && <TRow label="Torque" value={ssData.torque ? "ON" : "OFF"} />}
                  <TRow label="L-Enc" value={String(ssData.left_encoder  ?? "—")} />
                  <TRow label="R-Enc" value={String(ssData.right_encoder ?? "—")} />
                  {ssData.battery != null   && <TRow label="Batt"   value={`${f(ssData.battery, 2)} V`} />}
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
                <div className="flex-1 h-1.5 bg-[#1a1a1a] overflow-hidden border border-[#2a2a2a]">
                  <div
                    className={`h-full transition-all ${
                      (batPct ?? 0) < 20 ? "bg-red-700" : (batPct ?? 0) < 50 ? "bg-[#666666]" : "bg-green-700"
                    }`}
                    style={{ width: `${batPct ?? 0}%` }}
                  />
                </div>
                <span className={`text-xs font-black tabular-nums font-mono w-10 text-right ${
                  (batPct ?? 0) < 20 ? "text-red-500" : (batPct ?? 0) < 50 ? "text-[#888888]" : "text-green-600"
                }`}>{batPct ?? "—"}%</span>
              </div>
              <div className="flex gap-4 text-[10px] text-[#444444] font-mono">
                {batV != null && <span>V <span className="text-[#c0c0c0]">{f(batV, 2)}</span></span>}
                {batA != null && <span>A <span className="text-[#c0c0c0]">{f(batA, 2)}</span></span>}
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
                <div className="grid grid-cols-3 gap-1 w-fit mx-auto select-none">
                  <div /><KeyCap label="W" sub="전진" /><div />
                  <KeyCap label="A" sub="좌" />
                  <KeyCap label="S" sub="후진" />
                  <KeyCap label="D" sub="우" />
                </div>
                <p className="text-[9px] text-[#333333] text-center font-mono uppercase tracking-widest">
                  누르는 동안 이동 · 0.2 m/s · 1.0 rad/s
                </p>
              </>
            )}
          </div>
        </Section>

        {/* ── YOLO 감지 ───────────────────────────────────────────────────── */}
        <Section label="YOLO 감지">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 transition-colors ${
              detected ? "bg-red-600 danger-pulse shadow shadow-red-600/60" : "bg-[#1e1e1e]"
            }`} />
            <span className={`text-xs font-black uppercase tracking-widest font-mono ${
              detected ? "text-red-500" : "text-[#2a2a2a]"
            }`}>
              {detected ? "⚠ PERSON DETECTED" : "CLEAR"}
            </span>
          </div>
        </Section>

        {/* ── URDF 수신 여부 ──────────────────────────────────────────────── */}
        <Section label="robot_description">
          <span className={`text-[10px] font-black uppercase tracking-widest font-mono ${
            rdReceived ? "text-green-600" : "text-[#2a2a2a]"
          }`}>
            {rdReceived ? "◉ URDF RECEIVED" : "WAITING…"}
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
    <div className="flex flex-col gap-1">
      <p className="text-[9px] font-bold text-[#444444] uppercase tracking-[0.25em]">{label}</p>
      <div className="bg-[#0a0a0a] p-3 border border-[#1e1e1e] h-full">{children}</div>
    </div>
  );
}

function TRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <tr>
      <td className="text-[#444444] font-mono py-0.5 pr-2 whitespace-nowrap text-[10px]">{label}</td>
      <td className={`font-mono text-right text-[10px] ${
        highlight ? "text-red-500 font-black danger-pulse" : "text-[#c0c0c0]"
      }`}>{value}</td>
    </tr>
  );
}

function VelDisplay({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  const v = value ?? 0;
  const color = v > 0.001 ? "text-green-600" : v < -0.001 ? "text-red-500" : "text-[#333333]";
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
                      justify-center font-black text-[#c0c0c0] text-sm font-mono">
        {label}
      </div>
      <span className="text-[#333333] text-[9px] font-mono uppercase">{sub}</span>
    </div>
  );
}
