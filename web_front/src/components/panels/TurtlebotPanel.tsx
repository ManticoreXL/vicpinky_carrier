import { useEffect, useState, useCallback } from "react";
import { PanelProps } from "../../hooks/useRos";
import { RosMessage, CmdVelPayload } from "../../hooks/useNestSocket";
import {
  PanelCard, Section, BigStatus, BatteryBar,
  GoldButton, BlueButton, DangerButton, NoData,
} from "./BigPinkyPanel";
import { useKeyboardControl } from "../../hooks/useKeyboardControl";

interface StringMsg  { data: string }
interface BoolMsg    { data: boolean }
interface BatteryMsg { percentage: number }

interface BotState {
  mode: string;
  detected: boolean;
  battery: number | null;
}

const BOT_LABELS: Record<string, string> = {
  turtlebot1: "터틀봇 1",
  turtlebot2: "터틀봇 2",
  turtlebot3: "터틀봇 3",
  turtlebot4: "터틀봇 4",
};

interface Props extends PanelProps {
  botId: string;
  emitCmdVel: (payload: CmdVelPayload) => void;
  rosMessages: Record<string, RosMessage>;  // NestJS에서 수신한 전체 토픽 맵
}

export default function TurtlebotPanel({ subscribe, publish, botId, emitCmdVel, rosMessages }: Props) {
  const [state, setState] = useState<BotState>({ mode: "unknown", detected: false, battery: null });
  const [keyboardActive, setKeyboardActive] = useState(false);

  // ── roslibjs 구독 (rosbridge 직접) ────────────────────────────────────
  useEffect(() => {
    const subs = [
      subscribe<StringMsg>(`/${botId}/mode`, "std_msgs/String",
        (m) => setState((p) => ({ ...p, mode: m.data }))),
      subscribe<BoolMsg>(`/${botId}/yolo/person_detected`, "std_msgs/Bool",
        (m) => setState((p) => ({ ...p, detected: m.data }))),
      subscribe<BatteryMsg>(`/${botId}/battery`, "sensor_msgs/BatteryState",
        (m) => setState((p) => ({ ...p, battery: Math.round(m.percentage * 100) }))),
    ];
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe, botId]);

  // ── NestJS로부터 cmd_vel 수신 ─────────────────────────────────────────
  const cmdVelMsg = rosMessages[`/${botId}/cmd_vel`];
  const twist = cmdVelMsg?.data as { linear?: { x?: number }; angular?: { z?: number } } | undefined;
  const incomingLinear  = twist?.linear?.x  ?? null;
  const incomingAngular = twist?.angular?.z ?? null;

  // ── 키보드 조종 ───────────────────────────────────────────────────────
  const handleCmdVel = useCallback(
    (payload: CmdVelPayload) => emitCmdVel(payload),
    [emitCmdVel]
  );

  useKeyboardControl({
    botId,
    enabled: keyboardActive,
    publish: handleCmdVel,
    linearSpeed: 0.2,
    angularSpeed: 1.0,
  });

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKeyboardActive(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  const sendCmd = (cmd: string) =>
    publish(`/${botId}/cmd`, "std_msgs/String", { data: cmd });

  const modeColor =
    state.mode === "explore" ? "text-blue-400" :
    state.mode === "deliver" ? "text-amber-400" :
    state.mode === "stop"    ? "text-red-400"  : "text-blue-400/40";

  return (
    <div className="max-w-md">
      <PanelCard title={BOT_LABELS[botId] ?? botId} icon="🤖" accent="blue">

        {/* 현재 모드 */}
        <Section label="현재 모드">
          <div className="flex items-center justify-between gap-4">
            <BigStatus value={state.mode} color={modeColor} />
            <div className="flex gap-2">
              <BlueButton   onClick={() => sendCmd("explore")}>탐사</BlueButton>
              <GoldButton   onClick={() => sendCmd("deliver")}>수송</GoldButton>
              <DangerButton onClick={() => sendCmd("stop")}>정지</DangerButton>
            </div>
          </div>
        </Section>

        {/* cmd_vel 실시간 수신 (NestJS 경유) */}
        <Section label="cmd_vel 수신">
          {incomingLinear !== null ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <VelDisplay label="linear.x"  value={incomingLinear}  unit="m/s"   />
                <VelDisplay label="angular.z" value={incomingAngular} unit="rad/s" />
              </div>
              <p className="text-[10px] text-gray-600 text-right">
                {new Date(cmdVelMsg.timestamp).toLocaleTimeString()}
              </p>
            </div>
          ) : (
            <NoData />
          )}
        </Section>

        {/* 키보드 조종 */}
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
                  누르는 동안 이동 · 떼면 정지 · linear 0.2 m/s · angular 1.0 rad/s
                </p>
              </>
            )}
          </div>
        </Section>

        {/* YOLO 감지 */}
        <Section label="YOLO 감지">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-colors ${
              state.detected
                ? "bg-yellow-400 shadow-md shadow-yellow-400/50 animate-pulse"
                : "bg-blue-900"
            }`} />
            <span className={`text-sm font-semibold ${
              state.detected ? "text-yellow-400" : "text-blue-400/40"
            }`}>
              {state.detected ? "사람 감지됨" : "미감지"}
            </span>
          </div>
        </Section>

        {/* 배터리 */}
        <Section label="배터리">
          {state.battery !== null ? <BatteryBar pct={state.battery} /> : <NoData />}
        </Section>

      </PanelCard>
    </div>
  );
}

// ── 서브 컴포넌트 ──────────────────────────────────────────────────────────

function VelDisplay({ label, value, unit }: {
  label: string; value: number | null; unit: string;
}) {
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