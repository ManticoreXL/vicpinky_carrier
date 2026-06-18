import { useEffect, useState, useCallback } from "react";
import { PanelProps, PublishFn } from "../../hooks/useRos";
import {
 RosMessage, CmdVelPayload,
 ActionGoalPayload, ActionFeedback, ActionResult, ActiveGoals,
} from "../../hooks/useNestSocket";
import {
 PanelCard, Section, NoData,
} from "./BigPinkyPanel";
import { useKeyboardControl } from "../../hooks/useKeyboardControl";
import ActionPanel from "../ActionPanel";

type DiagStatus = "idle" | "loading" | "ok" | "error";
interface DiagResult {
 isOk: boolean;
 summary: string;
 errors: string[];
}

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
const f = (n: number, d = 2) => n.toFixed(d);

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
 callService: (serviceName: string, serviceType: string, request: Record<string, unknown>, callback: (res: unknown) => void) => void;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function TurtlebotPanel({
 publish, botId, emitCmdVel, rosMessages,
 emitAction, cancelAction, activeGoals, actionFeedbacks, actionResults,
 callService,
}: Props) {
 const [keyboardActive, setKeyboardActive] = useState(false);
 const [diagStatus, setDiagStatus] = useState<DiagStatus>("idle");
 const [diagResult, setDiagResult] = useState<DiagResult | null>(null);

 // 메시지가 끊겨도 오프라인 판정이 갱신되도록 1초마다 강제 리렌더
 const [, setTick] = useState(0);
 useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

 // ── 온라인 판정 — 최근 센서 토픽 수신 시각 기준 (4초 무수신이면 오프라인) ──
 const OFFLINE_MS = 4_000;
 const lastMsgTs = Math.max(
  rosMessages[`/${botId}/odom`]?.timestamp ?? 0,
  rosMessages[`/${botId}/imu`]?.timestamp ?? 0,
  rosMessages[`/${botId}/scan`]?.timestamp ?? 0,
  rosMessages[`/${botId}/battery_state`]?.timestamp ?? 0,
 );
 const online = lastMsgTs > 0 && Date.now() - lastMsgTs < OFFLINE_MS;

 // ── NestJS rosMessages에서 센서 데이터 추출 ──────────────────────────────
 // 오프라인이면 stale 데이터를 보여주지 않도록 undefined 반환 → 각 카드 NoData 표시
 const p = (topic: string) => (online ? rosMessages[`/${botId}/${topic}`]?.data : undefined);

 // // cmd_vel
 // const cvData = p("cmd_vel") as { linear?: { x?: number }; angular?: { z?: number } } | undefined;
 // const cvLinear = cvData?.linear?.x ?? null;
 // const cvAngular = cvData?.angular?.z ?? null;
 // 수정 (TwistStamped)
 const cvData = p("cmd_vel") as { twist?: { linear?: { x?: number }; angular?: { z?: number } } } | undefined;
 const cvLinear = cvData?.twist?.linear?.x ?? null;
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
 const odomV = odomData?.twist?.twist?.linear?.x ?? null;
 const odomW = odomData?.twist?.twist?.angular?.z ?? null;

 // imu
 const imuData = p("imu") as {
 orientation?: { x?: number; y?: number; z?: number; w?: number };
 angular_velocity?: { x?: number; y?: number; z?: number };
 linear_acceleration?: { x?: number; y?: number; z?: number };
 } | undefined;
 const imuOri = imuData?.orientation;
 const imuRoll = imuOri ? r2d(quatToRoll(imuOri as { x: number; y: number; z: number; w: number })) : null;
 const imuPitch = imuOri ? r2d(quatToPitch(imuOri as { x: number; y: number; z: number; w: number })) : null;
 const imuYaw = imuOri ? r2d(quatToYaw(imuOri as { x: number; y: number; z: number; w: number })) : null;
 const imuAV = imuData?.angular_velocity;
 const imuLA = imuData?.linear_acceleration;

 // scan — range_min/range_max 기준으로 유효 포인트 필터
 const scanData = p("scan") as {
 angle_min?: number; angle_max?: number; angle_increment?: number;
 range_min?: number; range_max?: number;
 ranges?: number[]; intensities?: number[];
 } | undefined;
 const rawRanges = scanData?.ranges ?? [];
 const rMin = scanData?.range_min ?? 0;
 const rMax = scanData?.range_max ?? Infinity;
 const validRanges = rawRanges.filter((r) => isFinite(r) && r >= rMin && r <= rMax);
 const scanNearest = validRanges.length > 0 ? Math.min(...validRanges) : null;
 const scanTotal = rawRanges.length;
 const scanValid = validRanges.length;

 // ── 키보드 조종 ──────────────────────────────────────────────────────────
 const handleCmdVel = useCallback((payload: CmdVelPayload) => emitCmdVel(payload), [emitCmdVel]);
 useKeyboardControl({ botId, enabled: keyboardActive, publish: handleCmdVel, linearSpeed: 0.2, angularSpeed: 1.0 });

 useEffect(() => {
 const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setKeyboardActive(false); };
 window.addEventListener("keydown", onEsc);
 return () => window.removeEventListener("keydown", onEsc);
 }, []);

 const runDiagnosis = useCallback(() => {
 setDiagStatus("loading");
 setDiagResult(null);
 callService(
 `/${botId}/run_diagnosis`,
 "turtlebot3_custom_msgs/srv/SelfDiagnosis",
 { target_component: "all" },
 (res) => {
 const r = res as { is_ok?: boolean; summary_message?: string; error_details?: string[] };
 const result: DiagResult = {
 isOk: r.is_ok ?? false,
 summary: r.summary_message ?? "",
 errors: r.error_details ?? [],
 };
 setDiagResult(result);
 setDiagStatus(result.isOk ? "ok" : "error");
 },
 );
 }, [botId, callService]);

 return (
 <div className="max-w-2xl">
 <PanelCard title={BOT_LABELS[botId] ?? botId} icon="🤖" accent="blue" badge={botId}>

 {/* ── 오프라인 배너 ─────────────────────────────────────────────── */}
 {!online && (
 <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-red-500/25 bg-red-500/10">
 <span className="w-2 h-2 rounded-full bg-red-500" />
 <span className="text-xs font-semibold text-red-600">오프라인 — 센서 데이터 수신 없음</span>
 </div>
 )}

 {/* ── 센서 그리드 (2열) ─────────────────────────────────────────── */}
 <div className="grid grid-cols-2 gap-4">

 {/* Odometry */}
 <SensorCard label="Odometry">
 {odomPos ? (
 <table className="w-full text-xs">
 <tbody>
 <TRow label="X" value={`${f(odomPos.x ?? 0)} m`} />
 <TRow label="Y" value={`${f(odomPos.y ?? 0)} m`} />
 <TRow label="Yaw" value={odomYaw != null ? `${f(odomYaw, 1)}°` : "—"} />
 <TRow label="v" value={odomV != null ? `${f(odomV, 3)} m/s` : "—"} />
 <TRow label="ω" value={odomW != null ? `${f(odomW, 3)} rad/s` : "—"} />
 </tbody>
 </table>
 ) : <NoData />}
 </SensorCard>

 {/* IMU */}
 <SensorCard label="IMU">
 {imuOri ? (
 <table className="w-full text-xs">
 <tbody>
 <TRow label="Roll" value={imuRoll != null ? `${f(imuRoll, 1)}°` : "—"} />
 <TRow label="Pitch" value={imuPitch != null ? `${f(imuPitch, 1)}°` : "—"} />
 <TRow label="Yaw" value={imuYaw != null ? `${f(imuYaw, 1)}°` : "—"} />
 {imuAV && <TRow label="ω.z" value={`${f(imuAV.z ?? 0, 3)} r/s`} />}
 {imuLA && <TRow label="a.x" value={`${f(imuLA.x ?? 0, 3)} m/s²`} />}
 </tbody>
 </table>
 ) : <NoData />}
 </SensorCard>

 {/* LIDAR Scan */}
 <SensorCard label="LIDAR Scan">
 {scanData ? (
 <table className="w-full text-xs">
 <tbody>
 <TRow label="최근접" value={scanNearest != null ? `${f(scanNearest)} m` : "—"} highlight={scanNearest != null && scanNearest < 0.3} />
 <TRow label="유효점" value={`${scanValid} / ${scanTotal}`} />
 <TRow label="범위 min" value={scanData.range_min != null ? `${f(scanData.range_min)} m` : "—"} />
 <TRow label="범위 max" value={scanData.range_max != null ? `${f(scanData.range_max)} m` : "—"} />
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
 <div className="flex-1 h-1.5 bg-[#FFCE99]/32 overflow-hidden border border-white/[0.1]">
 <div
 className={`h-full transition-all ${
 (batPct ?? 0) < 20 ? "bg-red-700" : (batPct ?? 0) < 50 ? "bg-amber-400" : "bg-green-700"
 }`}
 style={{ width: `${batPct ?? 0}%` }}
 />
 </div>
 <span className={`text-xs font-semibold tabular-nums w-10 text-right ${
 (batPct ?? 0) < 20 ? "text-white/90" : (batPct ?? 0) < 50 ? "text-white/[0.75]" : "text-green-600"
 }`}>{batPct ?? "—"}%</span>
 </div>
 <div className="flex gap-4 text-xs text-white/[0.6] ">
 {batV != null && <span>V <span className="text-white/90">{f(batV, 2)}</span></span>}
 {batA != null && <span>A <span className="text-white/90">{f(batA, 2)}</span></span>}
 </div>
 </div>
 ) : <NoData />}
 </Section>

 {/* ── cmd_vel 수신 ────────────────────────────────────────────────── */}
 <Section label="cmd_vel 수신">
 {cvLinear !== null ? (
 <div className="flex flex-col gap-2">
 <div className="grid grid-cols-2 gap-2">
 <VelDisplay label="linear.x" value={cvLinear} unit="m/s" />
 <VelDisplay label="angular.z" value={cvAngular} unit="rad/s" />
 </div>
 <p className="text-xs text-gray-600 text-right">
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
 className={`w-full py-2.5 text-xs font-semibold tracking-wide transition-all border ${
 keyboardActive
 ? "border-white/[0.1] bg-green-950/30 text-white/90"
 : "border-white/[0.1] bg-transparent text-white/[0.6] hover:border-white/[0.1] hover:text-white/[0.75]"
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
 <p className="text-xs text-white/[0.55] text-center tracking-wide">
 누르는 동안 이동 · 0.2 m/s · 1.0 rad/s
 </p>
 </>
 )}
 </div>
 </Section>

 {/* ── 자가진단 ─────────────────────────────────────────────────────── */}
 <Section label="자가진단">
 <div className="flex flex-col gap-3">
 <div className="flex items-center justify-between gap-4">
 <div className="flex items-center gap-2">
 {diagStatus === "idle" && <span className="text-xs text-white/[0.55] tracking-wide">대기 중</span>}
 {diagStatus === "loading" && <span className="text-xs text-white/90 tracking-wide animate-pulse">진단 중…</span>}
 {diagStatus === "ok" && <span className="text-xs text-white/90 font-semibold tracking-wide">◉ 정상</span>}
 {diagStatus === "error" && <span className="text-xs text-white/90 font-semibold tracking-wide ">⚠ 이상 감지</span>}
 </div>
 <button
 onClick={runDiagnosis}
 disabled={diagStatus === "loading"}
 className={`px-4 py-1.5 border text-xs font-bold tracking-wide transition-all ${
 diagStatus === "loading"
 ? "border-white/[0.1] bg-transparent text-white/[0.55] cursor-not-allowed"
 : "border-white/[0.1] bg-[#FFCE99]/32 text-white/[0.75] hover:bg-[#FFCE99]/32 hover:border-white/[0.1] hover:text-white/90"
 }`}
 >
 {diagStatus === "loading" ? "진단 중…" : "자가진단 시작"}
 </button>
 </div>
 {diagResult && (
 <div className={`text-xs p-2.5 border ${
 diagResult.isOk
 ? "border-white/[0.1] bg-green-950/20 text-white/90"
 : "border-white/[0.1] bg-red-950/20 text-white/90"
 }`}>
 <p className="font-bold">{diagResult.summary}</p>
 {diagResult.errors.length > 0 && (
 <ul className="mt-2 space-y-1">
 {diagResult.errors.map((e, i) => (
 <li key={i}>• {e}</li>
 ))}
 </ul>
 )}
 </div>
 )}
 </div>
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

 {/* ── 음성 명령 (/speak_cmd) ─────────────────────────────────────── */}
 <SpeakCmdPanel botId={botId} publish={publish} />

 </PanelCard>
 </div>
 );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function SensorCard({ label, children }: { label: string; children: React.ReactNode }) {
 return (
 <div className="flex flex-col gap-1">
 <p className="text-xs font-bold text-white/[0.6] tracking-[0.25em]">{label}</p>
 <div className="bg-[#FFCE99]/32 p-3 border border-white/[0.1] h-full">{children}</div>
 </div>
 );
}

function TRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
 return (
 <tr>
 <td className="text-white/[0.6] py-0.5 pr-2 whitespace-nowrap text-xs">{label}</td>
 <td className={` text-right text-xs ${
 highlight ? "text-white/90 font-semibold " : "text-white/90"
 }`}>{value}</td>
 </tr>
 );
}

function VelDisplay({ label, value, unit }: { label: string; value: number | null; unit: string }) {
 const v = value ?? 0;
 const color = v > 0.001 ? "text-green-600" : v < -0.001 ? "text-white/90" : "text-white/[0.55]";
 return (
 <div className="bg-[#FFCE99]/32 border border-white/[0.1] px-3 py-2 flex flex-col gap-0.5">
 <span className="text-xs text-white/[0.55] tracking-wide ">{label}</span>
 <span className={`text-lg font-semibold tabular-nums ${color}`}>
 {v >= 0 ? "+" : ""}{v.toFixed(3)}
 <span className="text-xs text-white/[0.55] ml-1">{unit}</span>
 </span>
 </div>
 );
}

function KeyCap({ label, sub }: { label: string; sub: string }) {
 return (
 <div className="flex flex-col items-center gap-0.5">
 <div className="w-10 h-10 bg-[#FFCE99]/32 border border-white/[0.1] flex items-center
 justify-center font-semibold text-white/90 text-sm ">
 {label}
 </div>
 <span className="text-white/[0.55] text-xs ">{sub}</span>
 </div>
 );
}

// ── SpeakCmdPanel ─────────────────────────────────────────────────────────────
// 마이크로 말하면 STT → /{botId}/speak_cmd (std_msgs/String) 자동 발행

type SpeakStatus = "idle" | "listening" | "sent";

function SpeakCmdPanel({ botId, publish }: { botId: string; publish: PublishFn }) {
 const [lastText, setLastText] = useState("");
 const [status, setStatus]     = useState<SpeakStatus>("idle");
 const sttTarget = `speak-cmd-${botId}`;

 // AiAssistant로부터 STT 결과 수신
 useEffect(() => {
  const onStt = (e: Event) => {
   const ce = e as CustomEvent<{ target?: string; text?: string }>;
   if (ce.detail?.target !== sttTarget || !ce.detail?.text) return;
   const text = ce.detail.text.trim();
   if (!text) return;
   setLastText(text);
   setStatus("sent");
   publish(`/${botId}/speak_cmd`, "std_msgs/String", { data: text });
   setTimeout(() => setStatus("idle"), 2000);
  };
  window.addEventListener("stt-result", onStt);
  return () => window.removeEventListener("stt-result", onStt);
 }, [botId, publish, sttTarget]);

 // listening 상태 동기화 (start-stt 발행 직후)
 useEffect(() => {
  const onStart = (e: Event) => {
   const ce = e as CustomEvent<{ target?: string }>;
   if (ce.detail?.target === sttTarget) setStatus("listening");
  };
  window.addEventListener("start-stt", onStart);
  return () => window.removeEventListener("start-stt", onStart);
 }, [sttTarget]);

 const startMic = () => {
  window.dispatchEvent(new CustomEvent("start-stt", { detail: { target: sttTarget } }));
 };

 const resend = () => {
  if (!lastText) return;
  publish(`/${botId}/speak_cmd`, "std_msgs/String", { data: lastText });
  setStatus("sent");
  setTimeout(() => setStatus("idle"), 2000);
 };

 return (
  <Section label="음성 명령 (/speak_cmd)">
   <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
     {/* 마이크 버튼 */}
     <button
      onClick={startMic}
      disabled={status === "listening"}
      title="음성 인식 시작"
      className={`w-9 h-9 flex-none border flex items-center justify-center transition-all ${
       status === "listening"
        ? "border-purple-500/40 bg-purple-500/10 text-purple-600 animate-pulse cursor-not-allowed"
        : "border-white/[0.1] bg-transparent text-white/[0.6] hover:border-purple-500/30 hover:text-purple-600"
      }`}
     >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
      </svg>
     </button>

     {/* 상태 표시 */}
     <span className={`flex-1 text-xs ${
      status === "listening" ? "text-purple-600 animate-pulse" :
      status === "sent"      ? "text-green-500" : "text-white/[0.55]"
     }`}>
      {status === "listening" ? "인식 중…" :
       status === "sent"      ? "전송 완료" :
       lastText               ? lastText : "마이크를 눌러 말하세요"}
     </span>

     {/* 재전송 버튼 */}
     {lastText && status === "idle" && (
      <button
       onClick={resend}
       className="px-3 py-1 text-xs border border-white/[0.1] bg-transparent text-white/[0.6]
                  hover:text-white/[0.82] hover:border-white/[0.12] transition-all"
      >
       재전송
      </button>
     )}
    </div>

    {/* 마지막 인식 텍스트 (별도 행) */}
    {lastText && status !== "idle" && (
     <div className="bg-[#FFCE99]/32 border border-white/[0.1] px-3 py-2 text-xs text-white/[0.68] break-all">
      {lastText}
     </div>
    )}
   </div>
  </Section>
 );
}
