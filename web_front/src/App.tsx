import { useState, useCallback } from "react";
import { robotStatusKo } from "./utils/statusLabel";
import { useRos } from "./hooks/useRos";
import { useNestSocket } from "./hooks/useNestSocket";
import type { RosMessage } from "./hooks/useNestSocket";
import StatusBadge from "./components/StatusBadge";
import RobotSidebar from "./components/RobotSidebar";
import VicPinkyPanel from "./components/panels/BigPinkyPanel";
import PinkyBotPanel from "./components/panels/PinkyBotPanel";
import TurtlebotPanel from "./components/panels/TurtlebotPanel";
import RobotStagePanel from "./components/RobotStagePanel";
import { batteryPercent } from "./utils/battery";
import OmxPanel from "./components/panels/OmxPanel";
import ExploreView from "./views/ExploreView";
import FmsView from "./views/FmsView";
import TaskManagerView from "./views/TaskManagerView";
import FlowView from "./views/FlowView";
import AdminView from "./views/AdminView";
import SuitabilityView from "./views/SuitabilityView";
import QueueTestView from "./views/QueueTestView";
import BuilderView from "./views/BuilderView";
import GlobalTaskQueueBar from "./components/GlobalTaskQueueBar";
import BatteryAlertModal from "./components/modals/BatteryAlertModal";
import FallAlertModal from "./components/modals/FallAlertModal";
import TaskFailedAlertModal from "./components/modals/TaskFailedAlertModal";
import NoPathAlertModal from "./components/modals/NoPathAlertModal";
import LowBatteryAlertModal from "./components/modals/LowBatteryAlertModal";
import BatteryChargedModal from "./components/modals/BatteryChargedModal";
import ControlCameraPanel from "./components/cameras/ControlCameraPanel";
import { useBatteryAlerts } from "./hooks/useBatteryAlerts";
import { useThrottled } from "./hooks/useThrottled";
import AiAssistant from "./components/AiAssistant";
import MobileRobotControl from "./components/MobileRobotControl";
import PolicyVisionPanel from "./components/cameras/PolicyVisionPanel";

type AppMode = "control" | "explore" | "fms" | "tasks" | "flow" | "admin" | "suitability" | "queue" | "builder";

export default function App() {
 const { connected, error, subscribe } = useRos();
 const {
 emitCmdVel, emitPublish, emitAction, cancelAction, callService,
 emitFmsDispatch, emitFmsAutoCharge, emitFmsRegister, emitNodeLock,
 emitNavInitialPose,
 nestConnected, rosMessages, socket,
 activeGoals, actionFeedbacks, actionResults,
 mapTimestamps, mapInfos,
 fmsTasks, tmAlerts, ackTmAlert, setRobotHome, emitReturnHome,
 robots, robotStatuses, lockedNodes,
 } = useNestSocket();

 // publish를 socket.io 경유로 라우팅 (원격 클라이언트에서도 동작)
 const socketPublish = useCallback(
 (topicName: string, messageType: string, message: Record<string, unknown>) => {
 emitPublish({ topicName, messageType, message });
 },
 [emitPublish],
 );
 const [selectedRobot, setSelectedRobot] = useState<string>("vicpinky");
 const [appMode, setAppMode] = useState<AppMode>("control");
 const [sidebarOpen, setSidebarOpen] = useState(false);

 const { notifications, confirmNotification } = useBatteryAlerts(rosMessages);
 const displayMessages = useThrottled(rosMessages, 1000);
 const isExplore = appMode === "explore";
 const isFms     = appMode === "fms";
 const isTasks   = appMode === "tasks";
 const isFlow    = appMode === "flow";
 const isAdmin   = appMode === "admin";
 const isSuitability = appMode === "suitability";
 const isQueue   = appMode === "queue";
 const isBuilder = appMode === "builder";
 // 글로벌 태스크 큐 바를 상단에 띄울 모드 (태스크/플릿/정찰/적합도/테스트)
 const showQueueBar = isTasks || isFms || isExplore || isSuitability || isQueue;

 return (
   <div className="flex flex-col h-screen bg-transparent text-[#521C0D] overflow-hidden relative font-sans min-w-0">
     {/* ── Header ────────────────────────────────────────────────────────── */}
     <header className="flex-none glass-panel border-b border-white/[0.1] px-4 sm:px-6 py-3
                        flex items-center justify-between z-20 shadow-lg gap-3 min-w-0">
       {/* 로고 */}
       <div className="flex items-center gap-3 flex-none">
         <div className="w-10 h-10 rounded-xl border border-orange-500/30 bg-orange-500/10
                         flex items-center justify-center text-orange-600 shadow-lg shadow-orange-500/10">
           <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
               d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
           </svg>
         </div>
         <div className="hidden sm:block">
           <h1 className="text-sm font-semibold text-white leading-none tracking-tight">
             {isExplore ? "재난 모니터링" : isTasks ? "태스크 관리" : isFms ? "플릿 명령 할당" : isFlow ? "작업 흐름도" : isAdmin ? "시스템 설정" : isSuitability ? "적합 로봇 판정" : isQueue ? "테스트 / 이벤트" : isBuilder ? "시나리오 빌더" : "로봇 제어"}
           </h1>
           <p className="text-[10px] text-white/[0.55] leading-none mt-1 tracking-widest">
             통합 관제 센터
           </p>
         </div>
       </div>

       {/* 모드 전환 — 중앙 */}
       <div className="flex bg-[#FFCE99]/32 backdrop-blur-xl p-1 rounded-xl border border-white/[0.1] shadow-inner overflow-x-auto">
         <ModeBtn mode="control" active={appMode === "control"} onClick={() => setAppMode("control")}>제어</ModeBtn>
         <ModeBtn mode="tasks"   active={appMode === "tasks"}   onClick={() => setAppMode("tasks")}>태스크</ModeBtn>
         <ModeBtn mode="fms"     active={appMode === "fms"}     onClick={() => setAppMode("fms")}>플릿</ModeBtn>
         <ModeBtn mode="flow"    active={appMode === "flow"}    onClick={() => setAppMode("flow")}>흐름도</ModeBtn>
         <ModeBtn mode="explore" active={appMode === "explore"} onClick={() => setAppMode("explore")}>정찰</ModeBtn>
         <ModeBtn mode="admin"   active={appMode === "admin"}   onClick={() => setAppMode("admin")}>관리</ModeBtn>
         <ModeBtn mode="suitability" active={appMode === "suitability"} onClick={() => setAppMode("suitability")}>적합도</ModeBtn>
         <ModeBtn mode="queue" active={appMode === "queue"} onClick={() => setAppMode("queue")}>테스트</ModeBtn>
         <ModeBtn mode="builder" active={appMode === "builder"} onClick={() => setAppMode("builder")}>빌더</ModeBtn>
       </div>

       {/* 상태 표시 — 우측 */}
       <div className="flex items-center gap-2 sm:gap-3 flex-none">
         {notifications.length > 0 && (
           <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-500/10
                           border border-red-500/25 rounded-lg">
             <span className="text-red-600 text-xs font-semibold hidden sm:inline">⚠ 알림</span>
             <span className="w-4.5 h-4.5 bg-red-500 text-[#FFFDF1] text-[10px] font-bold
                              rounded-md flex items-center justify-center px-1">
               {notifications.length}
             </span>
           </div>
         )}

         <StatusBadge connected={connected} error={error} />

         <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-all duration-500 ${
           nestConnected
             ? "border-emerald-500/25 bg-emerald-500/5"
             : "border-red-500/25 bg-red-500/5"
         }`}>
           <div className={`w-1.5 h-1.5 rounded-full ${nestConnected ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
           <span className="text-[10px] font-semibold tracking-widest text-white/[0.68] hidden sm:inline">NEST</span>
         </div>
       </div>
     </header>

 {showQueueBar && <GlobalTaskQueueBar tasks={fmsTasks} />}

 {/* ── 본문 ──────────────────────────────────────────────────────────── */}
 <div className="flex flex-col sm:flex-row flex-1 overflow-hidden relative">
 {isAdmin ? (
 <div className="flex-1 overflow-hidden">
 <AdminView />
 </div>
 ) : isSuitability ? (
 <div className="flex-1 overflow-hidden">
 <SuitabilityView
 rosMessages={displayMessages}
 fmsTasks={fmsTasks}
 robots={robots}
 robotStatuses={robotStatuses}
 emitFmsDispatch={emitFmsDispatch}
 emitFmsRegister={emitFmsRegister}
 />
 </div>
 ) : isQueue ? (
 <div className="flex-1 overflow-hidden">
 <QueueTestView
 rosMessages={displayMessages}
 fmsTasks={fmsTasks}
 robots={robots}
 robotStatuses={robotStatuses}
 emitFmsDispatch={emitFmsDispatch}
 emitFmsRegister={emitFmsRegister}
 emitFmsAutoCharge={emitFmsAutoCharge}
 />
 </div>
 ) : isBuilder ? (
 <div className="flex-1 overflow-hidden">
 <BuilderView robots={robots} />
 </div>
 ) : isFlow ? (
 <div className="flex-1 overflow-hidden">
 <FlowView />
 </div>
 ) : isTasks ? (
 <div className="flex-1 overflow-hidden">
 <TaskManagerView
 rosMessages={displayMessages}
 fmsTasks={fmsTasks}
 emitFmsAutoCharge={emitFmsAutoCharge}
 robotStatuses={robotStatuses}
 tmAlerts={tmAlerts}
 robots={robots}
 onSelectRobotInFleet={(robotId) => {
   setSelectedRobot(robotId);
   setAppMode("fms");
 }}
 />
 </div>
 ) : isFms ? (
 <div className="flex-1 overflow-hidden">
 <FmsView
 rosMessages={displayMessages}
 fmsTasks={fmsTasks}
 socket={socket}
 emitNavInitialPose={emitNavInitialPose}
 tmAlerts={tmAlerts}
 setRobotHome={setRobotHome}
 emitNodeLock={emitNodeLock}
 lockedNodes={lockedNodes}
 robots={robots}
 robotStatuses={robotStatuses}
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
 fmsTasks={fmsTasks}
 robots={robots}
 robotStatuses={robotStatuses}
 emitNavInitialPose={emitNavInitialPose}
 setRobotHome={setRobotHome}
 emitNodeLock={emitNodeLock}
 lockedNodes={lockedNodes}
 />
 </div>
 ) : (
 <>
 <button
 onClick={() => setSidebarOpen(!sidebarOpen)}
 className="sm:hidden glass-panel py-3 text-[10px] font-bold text-white/[0.6]
            tracking-widest uppercase border-x-0 border-orange-500/10"
 >
 {sidebarOpen ? "▲ 접기" : `▼ 로봇 선택 — ${selectedRobot}`}
 </button>

 <div className={`${sidebarOpen ? 'flex' : 'hidden'} sm:flex flex-none z-10`}>
 <RobotSidebar
 robots={robots}
 selectedRobot={selectedRobot}
 onSelect={(id) => { setSelectedRobot(id); setSidebarOpen(false); }}
 rosMessages={displayMessages}
 />
 </div>

 <main className="flex-1 overflow-y-auto p-4 sm:p-8 bg-transparent min-w-0 z-0">
 {selectedRobot === "vicpinky" ? (
 <VicPinkyPanel
 subscribe={subscribe}
 publish={socketPublish}
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
 publish={socketPublish}
 callService={callService}
 />
 ) : selectedRobot.startsWith("tb3") ? (
 <>
 {/* 제어 화면 stage 표시 — 프론트에서만 /<botId>/robot_state 직접 구독(기존 로직 무관) */}
 <RobotStagePanel botId={selectedRobot} />
 <TurtlebotPanel
 subscribe={subscribe}
 publish={socketPublish}
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
 </>
 ) : selectedRobot ? (
 <GenericRobotPanel
 robotId={selectedRobot}
 rosMessages={displayMessages}
 liveStatus={robotStatuses[selectedRobot]}
 />
 ) : null}
 
 {appMode === "control" && selectedRobot && (
 <MobileRobotControl botId={selectedRobot} emitCmdVel={emitCmdVel} />
 )}
 </main>

 <div className="hidden sm:block z-10 p-4 min-w-0">
 {/* omx는 우측 WebRTC 카메라 대신 정책 추론 비전(MJPEG) 표시 */}
 {selectedRobot === "omx"
 ? <PolicyVisionPanel />
 : <ControlCameraPanel selectedRobot={selectedRobot} socket={socket} />}
 </div>
 </>
 )}
 </div>

 <BatteryAlertModal notifications={notifications} onConfirm={confirmNotification} />
 <FallAlertModal alerts={tmAlerts} onConfirm={ackTmAlert} />
 <TaskFailedAlertModal alerts={tmAlerts} onConfirm={ackTmAlert} />
 <NoPathAlertModal
 alerts={tmAlerts}
 onSwitchManual={(robotId, alertId) => {
 if (robotId) setSelectedRobot(robotId);
 setAppMode("control");
 ackTmAlert(alertId);
 }}
 onDismiss={ackTmAlert}
 />
 <LowBatteryAlertModal
 alerts={tmAlerts}
 onAutoCharge={(robotId, alertId) => {
 if (robotId) emitFmsAutoCharge(robotId);
 ackTmAlert(alertId);
 }}
 onConfirm={ackTmAlert}
 />
 <BatteryChargedModal
 alerts={tmAlerts}
 onReturnHome={(robotId, alertId) => {
 if (robotId) emitReturnHome(robotId);
 ackTmAlert(alertId);
 }}
 onConfirm={ackTmAlert}
 />
 <AiAssistant socket={socket} />

 {/* ── Footer ────────────────────────────────────────────────────────── */}
 <footer className="flex-none bg-[#FFCE99]/32 backdrop-blur-[28px] border-t border-white/[0.1] px-5 py-2
 flex justify-between items-center text-[10px] text-white/[0.55] tracking-widest uppercase">
 <span>Status: Nominal · Mode: {appMode}</span>
 <span className="hidden sm:inline opacity-50">{new Date().toLocaleTimeString()}</span>
 </footer>
 </div>
 );
}

// ── 제네릭 로봇 패널 ───────────────────────────────────────────────────────

function parseUrdf(xmlStr: string) {
 try {
 const parser = new DOMParser();
 const doc = parser.parseFromString(xmlStr, "application/xml");
 if (doc.querySelector("parsererror")) return null;
 const robot = doc.querySelector("robot");
 if (!robot) return null;
 const joints = Array.from(doc.querySelectorAll("joint"));
 return {
 modelName: robot.getAttribute("name") ?? "unknown",
 linkCount: doc.querySelectorAll("link").length,
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
 const batPct = batteryPercent(batData?.percentage);

 const odom = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { z?: number; w?: number } } } } | undefined;
 const pos = odom?.pose?.pose?.position;
 const ori = odom?.pose?.pose?.orientation;
 const yaw = ori ? Math.atan2(2 * (ori.w ?? 0) * (ori.z ?? 0), 1 - 2 * (ori.z ?? 0) ** 2) : null;

 const rdRaw = p("robot_description") as string | { data?: string } | undefined;
 const rdStr = typeof rdRaw === "string" ? rdRaw : (rdRaw as { data?: string })?.data ?? null;
 const urdf = rdStr ? parseUrdf(rdStr) : null;

 const receivedTopics = Object.keys(rosMessages)
 .filter(t => t.startsWith(`/${robotId}/`))
 .map(t => t.replace(`/${robotId}/`, ""))
 .slice(0, 12);

 const STATUS_C: Record<string, string> = {
 IDLE: "text-white/90", WORKING: "text-white/90",
 ERROR: "text-white/90", OFFLINE: "text-white/[0.45]",
 };

 return (
 <div className="max-w-2xl space-y-6">
 {/* 헤더 */}
 <div className="flex items-center gap-5 pb-6 border-b border-white/[0.1]">
 <div className="w-16 h-16 rounded-2xl glass-card flex items-center justify-center text-3xl select-none">
 🤖
 </div>
 <div>
 <h2 className="text-xl font-semibold tracking-wide text-white ">{robotId}</h2>
 <span className={`text-xs font-semibold tracking-wide ${STATUS_C[liveStatus ?? ""] ?? "text-white/[0.45]"}`}>
 {robotStatusKo(liveStatus)}
 </span>
 </div>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 <Section label="Deployment Model (URDF)">
 {urdf ? (
 <div className="space-y-2">
 <Row label="Asset Name" value={urdf.modelName} accent />
 <Row label="Node Count" value={String(urdf.linkCount)} />
 <Row label="Joint Count" value={String(urdf.jointCount)} />
 {urdf.jointNames.length > 0 && (
 <div className="mt-4">
 <span className="sub-label text-white/[0.4]">Active Articulations</span>
 <div className="mt-2 flex flex-wrap gap-1.5">
 {urdf.jointNames.map(n => (
 <span key={n} className="px-2 py-0.5 text-xs bg-[#FFCE99]/32 border border-white/[0.1] text-white/[0.6] rounded-md">{n}</span>
 ))}
 </div>
 </div>
 )}
 </div>
 ) : (
 <p className="text-xs text-white/[0.4] italic">Synchronizing robot telemetry...</p>
 )}
 </Section>

 <Section label="Telemetry Data">
 {batPct !== null && <Row label="Internal Power" value={`${batPct}%`} />}
 {pos?.x != null && (
 <>
 <Row label="Tactical X" value={`${pos.x.toFixed(3)} m`} />
 <Row label="Tactical Y" value={`${(pos.y ?? 0).toFixed(3)} m`} />
 </>
 )}
 {yaw != null && <Row label="Heading" value={`${(yaw * 180 / Math.PI).toFixed(1)}°`} />}
 {batPct === null && pos?.x == null && (
 <p className="text-xs text-white/[0.4] italic">Awaiting sensor uplink...</p>
 )}
 </Section>
 </div>

 {receivedTopics.length > 0 && (
 <Section label="Uplink Channels">
 <div className="flex flex-wrap gap-1.5">
 {receivedTopics.map(t => (
 <span key={t} className="px-2.5 py-1 text-xs bg-[#FFCE99]/14 border border-white/[0.1] text-white/[0.55] rounded-lg">{t}</span>
 ))}
 </div>
 </Section>
 )}
 </div>
 );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
 return (
 <div className="glass-card p-5">
 <span className="sub-label">{label}</span>
 <div className="mt-4">{children}</div>
 </div>
 );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
 return (
 <div className="flex justify-between text-xs py-1 border-b border-white/[0.08] last:border-0">
 <span className="text-white/[0.6]">{label}</span>
 <span className={accent ? "text-white/90 font-bold" : "text-white/80"}>{value}</span>
 </div>
 );
}

function ModeBtn({
 mode, active, onClick, children,
}: { mode: AppMode; active: boolean; onClick: () => void; children: React.ReactNode }) {
 return (
 <button
 onClick={onClick}
 className={`px-4 sm:px-6 py-2 text-[10px] sm:text-xs font-semibold tracking-widest
             transition-all duration-300 rounded-lg whitespace-nowrap ${
 active
   ? "bg-orange-500/15 text-orange-600 border border-orange-500/30 shadow-sm shadow-orange-500/10"
   : "text-white/[0.55] hover:text-white/[0.75] hover:bg-[#FFCE99]/32 border border-transparent"
 }`}
 >
 {children}
 </button>
 );
}
