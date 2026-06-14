import { useState } from "react";
import { useRos } from "./hooks/useRos";
import { useNestSocket } from "./hooks/useNestSocket";
import type { RosMessage } from "./hooks/useNestSocket";
import StatusBadge from "./components/StatusBadge";
import RobotSidebar from "./components/RobotSidebar";
import VicPinkyPanel from "./components/panels/BigPinkyPanel";
import PinkyBotPanel from "./components/panels/PinkyBotPanel";
import TurtlebotPanel from "./components/panels/TurtlebotPanel";
import OmxPanel from "./components/panels/OmxPanel";
import ExploreView from "./views/ExploreView";
import FmsView from "./views/FmsView";
import AdminView from "./views/AdminView";
import BatteryAlertModal from "./components/BatteryAlertModal";
import ControlCameraPanel from "./components/ControlCameraPanel";
import { useBatteryAlerts } from "./hooks/useBatteryAlerts";
import { useThrottled } from "./hooks/useThrottled";

type AppMode = "control" | "explore" | "fms" | "admin";

const MODE_THEME = {
  control: {
    accent:       "text-red-400",
    border:       "border-red-900/50",
    borderLight:  "border-red-900/30",
    logoBorder:   "border-red-800/60",
    bg:           "bg-red-950/40",
    bgActive:     "bg-[#1a0000]",
    shadow:       "shadow-red-900/40",
  },
  fms: {
    accent:       "text-blue-400",
    border:       "border-blue-900/50",
    borderLight:  "border-blue-900/30",
    logoBorder:   "border-blue-800/60",
    bg:           "bg-blue-950/40",
    bgActive:     "bg-[#00001a]",
    shadow:       "shadow-blue-900/40",
  },
  explore: {
    accent:       "text-amber-400",
    border:       "border-amber-900/50",
    borderLight:  "border-amber-900/30",
    logoBorder:   "border-amber-800/60",
    bg:           "bg-amber-950/40",
    bgActive:     "bg-[#1a0f00]",
    shadow:       "shadow-amber-900/40",
  },
  admin: {
    accent:       "text-indigo-400",
    border:       "border-indigo-900/50",
    borderLight:  "border-indigo-900/30",
    logoBorder:   "border-indigo-800/60",
    bg:           "bg-indigo-950/40",
    bgActive:     "bg-[#07001a]",
    shadow:       "shadow-indigo-900/40",
  },
} as const;

export default function App() {
  const { connected, error, subscribe, publish } = useRos();
  const {
    emitCmdVel, emitAction, cancelAction, callService,
    emitFmsDispatch, emitFmsCancel,
    emitNavGoal, emitNavInitialPose,
    nestConnected, rosMessages, socket,
    activeGoals, actionFeedbacks, actionResults,
    mapTimestamps, mapInfos,
    fmsTasks, tmAlerts, ackTmAlert, setRobotHome,
    robotStatuses,
  } = useNestSocket();
  const [selectedRobot, setSelectedRobot] = useState<string>("vicpinky");
  const [appMode, setAppMode]             = useState<AppMode>("control");

  const { notifications, confirmNotification } = useBatteryAlerts(rosMessages);
  const displayMessages = useThrottled(rosMessages, 1000);
  const isExplore = appMode === "explore";
  const isFms     = appMode === "fms";
  const isAdmin   = appMode === "admin";

  return (
    <div className="flex flex-col h-screen bg-[#050505] text-[#d4d4d4]">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className={`flex-none bg-[#0a0a0a] border-b px-5 py-2.5
                         flex items-center justify-between z-10 shadow-lg shadow-black/80
                         ${MODE_THEME[appMode].border}`}>
        {/* 로고 */}
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded border flex items-center
                          justify-center font-black text-xs select-none tracking-widest shadow
                          ${MODE_THEME[appMode].logoBorder}
                          ${MODE_THEME[appMode].bg}
                          ${MODE_THEME[appMode].accent}
                          ${MODE_THEME[appMode].shadow}`}>
            {isExplore ? "SOS" : isFms ? "FMS" : isAdmin ? "ADM" : "ROS"}
          </div>
          <div>
            <h1 className="text-xs font-bold text-[#c0c0c0] leading-tight tracking-[0.2em] uppercase">
              {isExplore ? "DISASTER RECON SYSTEM" : isFms ? "FLEET MANAGEMENT SYSTEM" : isAdmin ? "ADMIN PANEL" : "ROS2 관제 시스템"}
            </h1>
            <p className="text-[10px] text-[#444444] leading-tight font-mono tracking-widest">
              {isExplore ? "재난 탐사 모니터링" : isFms ? "TASK DISPATCH & MONITORING" : isAdmin ? "ROBOT · MAP · NODE · EDGE · TASK" : "ROBOT CONTROL INTERFACE"}
            </p>
          </div>
        </div>

        {/* 모드 토글 + 상태 */}
        <div className="flex items-center gap-5">
          {/* 모드 전환 */}
          <div className="flex border border-[#222222] rounded overflow-hidden">
            <ModeBtn mode="control" active={appMode === "control"} onClick={() => setAppMode("control")} border>◈ 관제</ModeBtn>
            <ModeBtn mode="fms"     active={appMode === "fms"}     onClick={() => setAppMode("fms")}     border>⬡ FMS</ModeBtn>
            <ModeBtn mode="explore" active={appMode === "explore"} onClick={() => setAppMode("explore")} border>⚠ 탐사</ModeBtn>
            <ModeBtn mode="admin"   active={appMode === "admin"}   onClick={() => setAppMode("admin")}        >⚙ 관리</ModeBtn>
          </div>

          {/* 상태 표시 */}
          <div className="flex items-center gap-4">
            {notifications.length > 0 && (
              <div className="relative">
                <span className="text-red-500 text-sm danger-pulse">⚠</span>
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-0.5
                                 bg-red-700 text-white text-[9px] font-black rounded
                                 flex items-center justify-center border border-red-500/40">
                  {notifications.length}
                </span>
              </div>
            )}
            <StatusBadge connected={connected} error={error} />
            <span className={`flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-widest ${
              nestConnected ? "text-green-600" : "text-red-600"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                nestConnected ? "bg-green-600 animate-pulse" : "bg-red-600"
              }`} />
              NEST
            </span>
          </div>
        </div>
      </header>

      {/* ── 본문 ──────────────────────────────────────────────────────────── */}
      {isAdmin ? (
        <div className="flex-1 overflow-hidden">
          <AdminView />
        </div>
      ) : isFms ? (
        <div className="flex-1 overflow-hidden">
          <FmsView
            rosMessages={displayMessages}
            fmsTasks={fmsTasks}
            socket={socket}
            emitFmsDispatch={emitFmsDispatch}
            emitFmsCancel={emitFmsCancel}
            emitNavGoal={emitNavGoal}
            emitNavInitialPose={emitNavInitialPose}
            tmAlerts={tmAlerts}
            ackTmAlert={ackTmAlert}
            setRobotHome={setRobotHome}
          />
        </div>
      ) : isExplore ? (
        <div className="flex-1 overflow-hidden">
          <ExploreView
            rosMessages={displayMessages}
            activeGoals={activeGoals}
            mapTimestamps={mapTimestamps}
            mapInfos={mapInfos}
            socket={socket}
          />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <RobotSidebar
            subscribe={subscribe}
            selectedRobot={selectedRobot}
            onSelect={setSelectedRobot}
            rosMessages={displayMessages}
            liveStatuses={robotStatuses}
          />
          <main className="flex-1 overflow-y-auto p-5 bg-[#050505] min-w-0">
            {selectedRobot === "vicpinky" ? (
              <VicPinkyPanel
                subscribe={subscribe}
                publish={publish}
                rosMessages={displayMessages}
                emitCmdVel={emitCmdVel}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
                callService={callService}
              />
            ) : selectedRobot === "pinky" ? (
              <PinkyBotPanel
                rosMessages={displayMessages}
                emitCmdVel={emitCmdVel}
                callService={callService}
              />
            ) : selectedRobot === "omx" ? (
              <OmxPanel
                subscribe={subscribe}
                publish={publish}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
                callService={callService}
              />
            ) : selectedRobot.startsWith("tb3") ? (
              <TurtlebotPanel
                subscribe={subscribe}
                publish={publish}
                botId={selectedRobot as "tb3_01"|"tb3_02"|"tb3_03"|"tb3_04"}
                emitCmdVel={emitCmdVel}
                rosMessages={displayMessages}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
                callService={callService}
              />
            ) : selectedRobot ? (
              <GenericRobotPanel
                robotId={selectedRobot}
                rosMessages={displayMessages}
                liveStatus={robotStatuses[selectedRobot]}
              />
            ) : null}
          </main>
          <ControlCameraPanel selectedRobot={selectedRobot} socket={socket} />
        </div>
      )}

      <BatteryAlertModal notifications={notifications} onConfirm={confirmNotification} />

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className={`flex-none bg-[#0a0a0a] border-t px-5 py-1.5
                         flex justify-between text-[10px] font-mono text-[#333333]
                         ${MODE_THEME[appMode].borderLight}`}>
        <span className="tracking-widest uppercase">
          {isExplore ? "DISASTER RECON — TACTICAL MONITORING" :
           isFms     ? "FLEET MANAGEMENT — TASK DISPATCH" :
           isAdmin   ? "ADMIN — ROBOT · MAP · NODE · EDGE · TASK" :
                       "ROS2 WEB DASHBOARD"}
        </span>
        <span>ROSBRIDGE :9090 · NESTJS :3001</span>
      </footer>
    </div>
  );
}

// ── 제네릭 로봇 패널 (DB에 있지만 전용 패널 없는 로봇) ──────────────────────

function parseUrdf(xmlStr: string) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, "application/xml");
    if (doc.querySelector("parsererror")) return null;
    const robot = doc.querySelector("robot");
    if (!robot) return null;
    const joints = Array.from(doc.querySelectorAll("joint"));
    return {
      modelName:  robot.getAttribute("name") ?? "unknown",
      linkCount:  doc.querySelectorAll("link").length,
      jointCount: joints.length,
      jointNames: joints.map(j => j.getAttribute("name") ?? "").filter(Boolean),
    };
  } catch { return null; }
}

function GenericRobotPanel({
  robotId, rosMessages, liveStatus,
}: { robotId: string; rosMessages: Record<string, RosMessage>; liveStatus?: string }) {
  const p = (topic: string) => rosMessages[`/${robotId}/${topic}`]?.data;

  const batData = p("battery_state") as { percentage?: number } | undefined;
  const batPct  = batData?.percentage != null
    ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
    : null;

  const odom = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { z?: number; w?: number } } } } | undefined;
  const pos  = odom?.pose?.pose?.position;
  const ori  = odom?.pose?.pose?.orientation;
  const yaw  = ori ? Math.atan2(2 * (ori.w ?? 0) * (ori.z ?? 0), 1 - 2 * (ori.z ?? 0) ** 2) : null;

  const rdRaw = p("robot_description") as string | { data?: string } | undefined;
  const rdStr = typeof rdRaw === "string" ? rdRaw : (rdRaw as { data?: string })?.data ?? null;
  const urdf  = rdStr ? parseUrdf(rdStr) : null;

  // 수신된 토픽 목록
  const receivedTopics = Object.keys(rosMessages)
    .filter(t => t.startsWith(`/${robotId}/`))
    .map(t => t.replace(`/${robotId}/`, ""))
    .slice(0, 12);

  const STATUS_C: Record<string, string> = {
    IDLE: "text-green-400", MOVING: "text-blue-400", WORKING: "text-yellow-400",
    ERROR: "text-red-400",  OFFLINE: "text-[#555]",
  };

  return (
    <div className="max-w-lg space-y-4">
      {/* 헤더 */}
      <div className="flex items-center gap-3 pb-3 border-b border-[#1a1a1a]">
        <div className="w-10 h-10 rounded border border-[#222] bg-[#0d0d0d] flex items-center justify-center text-xl select-none">
          🤖
        </div>
        <div>
          <h2 className="text-sm font-black uppercase tracking-widest text-[#c0c0c0] font-mono">{robotId}</h2>
          <span className={`text-[10px] font-bold font-mono ${STATUS_C[liveStatus ?? ""] ?? "text-[#555]"}`}>
            {liveStatus ?? "UNKNOWN"}
          </span>
        </div>
      </div>

      {/* URDF 정보 */}
      <Section label="ROBOT MODEL (URDF)">
        {urdf ? (
          <div className="space-y-1.5">
            <Row label="Model"   value={urdf.modelName} accent />
            <Row label="Links"   value={String(urdf.linkCount)} />
            <Row label="Joints"  value={String(urdf.jointCount)} />
            {urdf.jointNames.length > 0 && (
              <div>
                <span className="text-[9px] text-[#333] font-mono uppercase tracking-widest">Joint names</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {urdf.jointNames.map(n => (
                    <span key={n} className="px-1.5 py-0.5 text-[8px] font-mono bg-[#111] border border-[#222] text-[#666] rounded">{n}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-[#2a2a2a] font-mono">/{robotId}/robot_description 대기 중…</p>
        )}
      </Section>

      {/* 센서 데이터 */}
      <Section label="SENSOR DATA">
        {batPct !== null && <Row label="Battery" value={`${batPct}%`} />}
        {pos?.x != null && (
          <>
            <Row label="Pos X" value={pos.x.toFixed(3)} />
            <Row label="Pos Y" value={(pos.y ?? 0).toFixed(3)} />
          </>
        )}
        {yaw != null && <Row label="Yaw" value={`${(yaw * 180 / Math.PI).toFixed(1)}°`} />}
        {batPct === null && pos?.x == null && (
          <p className="text-[10px] text-[#2a2a2a] font-mono">토픽 대기 중…</p>
        )}
      </Section>

      {/* 수신 토픽 */}
      {receivedTopics.length > 0 && (
        <Section label="ACTIVE TOPICS">
          <div className="flex flex-wrap gap-1">
            {receivedTopics.map(t => (
              <span key={t} className="px-1.5 py-0.5 text-[8px] font-mono bg-[#0d0d0d] border border-[#1a1a1a] text-[#555] rounded">{t}</span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#1a1a1a] rounded bg-[#080808] p-3">
      <p className="text-[9px] font-bold text-[#444] uppercase tracking-[0.25em] font-mono mb-2">{label}</p>
      {children}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between text-[10px] font-mono py-0.5">
      <span className="text-[#444]">{label}</span>
      <span className={accent ? "text-green-400 font-bold" : "text-[#888]"}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ModeBtn({
  mode, active, onClick, border, children,
}: { mode: AppMode; active: boolean; onClick: () => void; border?: boolean; children: React.ReactNode }) {
  if (!(mode in MODE_THEME)) return null;
  const t = MODE_THEME[mode];
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest transition-all ${
        border ? "border-r border-[#222222]" : ""
      } ${active
        ? `${t.bgActive} ${t.accent}`
        : "bg-transparent text-[#444444] hover:text-[#888888]"
      }`}
    >
      {children}
    </button>
  );
}
