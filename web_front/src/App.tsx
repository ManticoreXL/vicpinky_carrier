import { useState } from "react";
import { useRos } from "./hooks/useRos";
import { useNestSocket, RosMessage } from "./hooks/useNestSocket";
import { RobotId } from "./types/robots";
import StatusBadge from "./components/StatusBadge";
import RobotSidebar from "./components/RobotSidebar";
import BigPinkyPanel from "./components/panels/BigPinkyPanel";
import TurtlebotPanel from "./components/panels/TurtlebotPanel";
import OmxPanel from "./components/panels/OmxPanel";

export default function App() {
  const { connected, error, subscribe, publish } = useRos();
  const { emitCmdVel, emitPublish, nestConnected, rosMessages } = useNestSocket();
  const [selectedRobot, setSelectedRobot] = useState<RobotId>("bigpinky");

  return (
    <div className="flex flex-col h-screen bg-[#010c1e] text-white">
      {/* Header */}
      <header className="flex-none bg-[#020e25] border-b border-amber-400/20 px-5 py-3 flex items-center justify-between shadow-lg z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center font-black text-sm text-[#010c1e] select-none shadow-md shadow-amber-500/20">
            R2
          </div>
          <div>
            <h1 className="text-sm font-bold text-amber-300 leading-tight tracking-wide">
              ROS2 관제 대시보드
            </h1>
            <p className="text-[11px] text-blue-400/60 leading-tight">Robot Control System</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge connected={connected} error={error} />
          {/* NestJS 연결 상태 */}
          <span className={`flex items-center gap-1.5 text-xs font-medium ${
            nestConnected ? "text-green-400" : "text-red-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              nestConnected ? "bg-green-400 animate-pulse" : "bg-red-400"
            }`} />
            NestJS
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <RobotSidebar
          subscribe={subscribe}
          selectedRobot={selectedRobot}
          onSelect={setSelectedRobot}
        />

        <main className="flex-1 overflow-y-auto p-6 bg-[#010c1e]">
          {selectedRobot === "bigpinky" && (
            <BigPinkyPanel subscribe={subscribe} publish={publish} />
          )}
          {(selectedRobot === "turtlebot1" ||
            selectedRobot === "turtlebot2" ||
            selectedRobot === "turtlebot3" ||
            selectedRobot === "turtlebot4") && (
            <TurtlebotPanel
              subscribe={subscribe}
              publish={publish}
              botId={selectedRobot}
              emitCmdVel={emitCmdVel}
              rosMessages={rosMessages}
            />
          )}
          {selectedRobot === "omx" && (
            <OmxPanel subscribe={subscribe} publish={publish} />
          )}
        </main>
      </div>

      <footer className="flex-none bg-[#020e25] border-t border-amber-400/10 px-5 py-2 flex justify-between text-[11px] text-blue-400/40">
        <span>ROS2 Web Dashboard</span>
        <span>rosbridge · ws://localhost:9090 · nestjs · :3001</span>
      </footer>
    </div>
  );
}