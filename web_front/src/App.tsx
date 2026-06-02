import { useState } from "react";
import { useRos } from "./hooks/useRos";
import { useNestSocket, RosMessage } from "./hooks/useNestSocket";
import { RobotId } from "./types/robots";
import StatusBadge from "./components/StatusBadge";
import RobotSidebar from "./components/RobotSidebar";
import BigPinkyPanel from "./components/panels/BigPinkyPanel";
import TurtlebotPanel from "./components/panels/TurtlebotPanel";
import OmxPanel from "./components/panels/OmxPanel";
import ExploreView from "./views/ExploreView";
import BatteryAlertModal from "./components/BatteryAlertModal";
import { useBatteryAlerts } from "./hooks/useBatteryAlerts";

type AppMode = "control" | "explore";

export default function App() {
  const { connected, error, subscribe, publish } = useRos();
  const {
    emitCmdVel, emitPublish, emitAction, cancelAction,
    nestConnected, rosMessages,
    activeGoals, actionFeedbacks, actionResults,
  } = useNestSocket();
  const [selectedRobot, setSelectedRobot] = useState<RobotId>("bigpinky");
  const [appMode, setAppMode]             = useState<AppMode>("control");
  const { notifications, confirmNotification } = useBatteryAlerts(rosMessages);

  const isExplore = appMode === "explore";

  return (
    <div className={`flex flex-col h-screen text-white ${
      isExplore ? "bg-[#030712]" : "bg-[#010c1e]"
    }`}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className={`flex-none px-5 py-3 flex items-center justify-between shadow-lg z-10 border-b ${
        isExplore
          ? "bg-[#060c18] border-red-900/40"
          : "bg-[#020e25] border-amber-400/20"
      }`}>

        {/* 로고 + 타이틀 */}
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center font-black text-sm select-none shadow-md ${
            isExplore
              ? "bg-gradient-to-br from-red-700 to-red-900 text-red-200 shadow-red-900/40"
              : "bg-gradient-to-br from-amber-400 to-amber-600 text-[#010c1e] shadow-amber-500/20"
          }`}>
            {isExplore ? "🚨" : "R2"}
          </div>
          <div>
            <h1 className={`text-sm font-bold leading-tight tracking-wide ${
              isExplore ? "text-red-400" : "text-amber-300"
            }`}>
              {isExplore ? "DISASTER RECON SYSTEM" : "ROS2 관제 대시보드"}
            </h1>
            <p className={`text-[11px] leading-tight ${
              isExplore ? "text-red-900/70" : "text-blue-400/60"
            }`}>
              {isExplore ? "재난 탐사 모니터링" : "Robot Control System"}
            </p>
          </div>
        </div>

        {/* 모드 토글 + 상태 */}
        <div className="flex items-center gap-4">
          {/* 모드 전환 버튼 */}
          <div className="flex items-center bg-[#050a14] rounded-lg p-0.5 border border-slate-700/30">
            <button
              onClick={() => setAppMode("control")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                !isExplore
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              ⚙ 관제
            </button>
            <button
              onClick={() => setAppMode("explore")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                isExplore
                  ? "bg-red-900/40 text-red-300 border border-red-700/40 shadow"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              🚨 탐사
            </button>
          </div>

          {/* 연결 상태 + 배터리 경보 뱃지 */}
          <div className="flex items-center gap-3">
            {/* 배터리 경보 뱃지 */}
            {notifications.length > 0 && (
              <div className="relative flex items-center">
                <span className="text-xl animate-pulse">🔋</span>
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1
                                 bg-red-600 text-white text-[10px] font-black rounded-full
                                 flex items-center justify-center shadow-lg shadow-red-900/60
                                 border border-red-400/40">
                  {notifications.length}
                </span>
              </div>
            )}
            <StatusBadge connected={connected} error={error} />
            <span className={`flex items-center gap-1.5 text-xs font-medium ${
              nestConnected ? "text-green-400" : "text-red-400"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                nestConnected ? "bg-green-400 animate-pulse" : "bg-red-400"
              }`} />
              NestJS
            </span>
          </div>
        </div>
      </header>

      {/* ── 본문 ──────────────────────────────────────────────────────────── */}
      {isExplore ? (
        // 탐사 모드: 풀스크린 ExploreView
        <div className="flex-1 overflow-hidden">
          <ExploreView
            rosMessages={rosMessages}
            activeGoals={activeGoals}
          />
        </div>
      ) : (
        // 관제 모드: 기존 사이드바 + 패널 레이아웃
        <div className="flex flex-1 overflow-hidden">
          <RobotSidebar
            subscribe={subscribe}
            selectedRobot={selectedRobot}
            onSelect={setSelectedRobot}
          />
          <main className="flex-1 overflow-y-auto p-6 bg-[#010c1e]">
            {selectedRobot === "bigpinky" && (
              <BigPinkyPanel
                subscribe={subscribe}
                publish={publish}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
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
                rosMessages={rosMessages}
                emitAction={emitAction}
                cancelAction={cancelAction}
                activeGoals={activeGoals}
                actionFeedbacks={actionFeedbacks}
                actionResults={actionResults}
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
              />
            )}
          </main>
        </div>
      )}

      {/* ── 배터리 알림 모달 (관제/탐사 모드 공통) ─────────────────────── */}
      <BatteryAlertModal
        notifications={notifications}
        onConfirm={confirmNotification}
      />

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className={`flex-none px-5 py-2 flex justify-between text-[11px] border-t ${
        isExplore
          ? "bg-[#060c18] border-red-900/20 text-red-900/50"
          : "bg-[#020e25] border-amber-400/10 text-blue-400/40"
      }`}>
        <span>{isExplore ? "DISASTER RECON SYSTEM — 재난 탐사 모니터링" : "ROS2 Web Dashboard"}</span>
        <span>rosbridge · ws://localhost:9090 · nestjs · :3001</span>
      </footer>
    </div>
  );
}
