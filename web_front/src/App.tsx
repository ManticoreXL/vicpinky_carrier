import { useState } from "react";
import { useRos } from "./hooks/useRos";
import { useNestSocket } from "./hooks/useNestSocket";
import { RobotId } from "./types/robots";
import StatusBadge from "./components/StatusBadge";
import RobotSidebar from "./components/RobotSidebar";
import VicPinkyPanel from "./components/panels/BigPinkyPanel";
import TurtlebotPanel from "./components/panels/TurtlebotPanel";
import OmxPanel from "./components/panels/OmxPanel";
import ExploreView from "./views/ExploreView";
import FmsView from "./views/FmsView";
import BatteryAlertModal from "./components/BatteryAlertModal";
import ControlCameraPanel from "./components/ControlCameraPanel";
import { useBatteryAlerts } from "./hooks/useBatteryAlerts";
import { useThrottled } from "./hooks/useThrottled";

type AppMode = "control" | "explore" | "fms";

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
    fmsTasks,
  } = useNestSocket();
  const [selectedRobot, setSelectedRobot] = useState<RobotId>("vicpinky");
  const [appMode, setAppMode]             = useState<AppMode>("control");

  const { notifications, confirmNotification } = useBatteryAlerts(rosMessages);
  const displayMessages = useThrottled(rosMessages, 1000);
  const isExplore = appMode === "explore";
  const isFms     = appMode === "fms";

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
            {isExplore ? "SOS" : isFms ? "FMS" : "ROS"}
          </div>
          <div>
            <h1 className="text-xs font-bold text-[#c0c0c0] leading-tight tracking-[0.2em] uppercase">
              {isExplore ? "DISASTER RECON SYSTEM" : isFms ? "FLEET MANAGEMENT SYSTEM" : "ROS2 관제 시스템"}
            </h1>
            <p className="text-[10px] text-[#444444] leading-tight font-mono tracking-widest">
              {isExplore ? "재난 탐사 모니터링" : isFms ? "TASK DISPATCH & MONITORING" : "ROBOT CONTROL INTERFACE"}
            </p>
          </div>
        </div>

        {/* 모드 토글 + 상태 */}
        <div className="flex items-center gap-5">
          {/* 모드 전환 */}
          <div className="flex border border-[#222222] rounded overflow-hidden">
            <ModeBtn mode="control" active={appMode === "control"} onClick={() => setAppMode("control")} border>◈ 관제</ModeBtn>
            <ModeBtn mode="fms"     active={appMode === "fms"}     onClick={() => setAppMode("fms")}     border>⬡ FMS</ModeBtn>
            <ModeBtn mode="explore" active={appMode === "explore"} onClick={() => setAppMode("explore")}      >⚠ 탐사</ModeBtn>
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
      {isFms ? (
        <div className="flex-1 overflow-hidden">
          <FmsView
            rosMessages={displayMessages}
            fmsTasks={fmsTasks}
            socket={socket}
            emitFmsDispatch={emitFmsDispatch}
            emitFmsCancel={emitFmsCancel}
            emitNavGoal={emitNavGoal}
            emitNavInitialPose={emitNavInitialPose}
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
          />
          <main className="flex-1 overflow-y-auto p-5 bg-[#050505] min-w-0">
            {selectedRobot === "vicpinky" && (
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
            )}
            {(selectedRobot === "tb3_01" ||
              selectedRobot === "tb3_02" ||
              selectedRobot === "tb3_03" ||
              selectedRobot === "tb3_04") && (
              <TurtlebotPanel
                subscribe={subscribe}
                publish={publish}
                botId={selectedRobot}
                emitCmdVel={emitCmdVel}
                rosMessages={displayMessages}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
                callService={callService}
              />
            )}
            {selectedRobot === "omx" && (
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
            )}
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
                       "ROS2 WEB DASHBOARD"}
        </span>
        <span>ROSBRIDGE :9090 · NESTJS :3001</span>
      </footer>
    </div>
  );
}

function ModeBtn({
  mode, active, onClick, border, children,
}: { mode: AppMode; active: boolean; onClick: () => void; border?: boolean; children: React.ReactNode }) {
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
