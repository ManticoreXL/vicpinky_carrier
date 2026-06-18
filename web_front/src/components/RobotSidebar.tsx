import { useThrottled } from "../hooks/useThrottled";
import type { RosMessage } from "../hooks/useNestSocket";
import type { RobotInfo } from "../hooks/useNestSocket";

const STATUS_COLOR: Record<string, string> = {
 IDLE:    "text-white/[0.68]",
 MOVING:  "text-orange-600",
 WORKING: "text-amber-600",
 ERROR:   "text-red-600",
 OFFLINE: "text-white/[0.45]",
};

const STATUS_DOT: Record<string, string> = {
 IDLE:    "bg-white/30",
 MOVING:  "bg-orange-500 animate-pulse",
 WORKING: "bg-amber-500 animate-pulse",
 ERROR:   "bg-red-500",
 OFFLINE: "bg-white/10",
};

interface Props {
 robots: RobotInfo[];
 selectedRobot: string;
 onSelect: (id: string) => void;
 rosMessages: Record<string, RosMessage>;
}

export default function RobotSidebar({ robots, selectedRobot, onSelect, rosMessages }: Props) {
 const displayMessages = useThrottled(rosMessages, 800);

 return (
  <aside className="w-56 sm:w-60 flex-none glass-panel border-r border-white/[0.1] flex flex-col overflow-y-auto">
   <div className="px-4 py-4 border-b border-white/[0.1]">
    <span className="sub-label">Fleet</span>
    <div className="flex items-center justify-between mt-1">
     <span className="text-sm font-semibold text-white/80 tracking-widest uppercase">Units</span>
     <span className="px-1.5 py-0.5 bg-orange-500/10 rounded text-[10px] text-orange-600 font-bold
                      border border-orange-500/20">{robots.length}</span>
    </div>
   </div>

   <div className="flex-1 overflow-y-auto p-3 space-y-1">
    {robots.length === 0 ? (
     <p className="px-3 py-8 text-xs text-white/[0.4] text-center italic">스캔 중...</p>
    ) : (
     robots.map(robot => (
      <RobotItem
       key={robot.robot_id}
       robot={robot}
       selected={selectedRobot === robot.robot_id}
       onSelect={onSelect}
       rosMessages={displayMessages}
      />
     ))
    )}
   </div>
  </aside>
 );
}

function RobotItem({
 robot, selected, onSelect, rosMessages,
}: {
 robot: RobotInfo;
 selected: boolean;
 onSelect: (id: string) => void;
 rosMessages: Record<string, RosMessage>;
}) {
 const { robot_id, status } = robot;

 // 온라인 여부: 상태가 OFFLINE이 아니거나, 최근 odom 토픽 수신 중
 const odomTs  = rosMessages[`/${robot_id}/odom`]?.timestamp ?? 0;
 const rosOnline = odomTs > 0 && Date.now() - odomTs < 5_000;
 const isOnline  = status !== "OFFLINE" || rosOnline;

 // 배터리: 서버 병합값(DB+텔레메트리) 우선, 없으면 ROS 토픽 파싱
 let batPct: number | null = robot.battery != null ? Math.round(robot.battery) : null;
 if (batPct === null) {
  const batData = rosMessages[`/${robot_id}/battery_state`]?.data as { percentage?: number } | undefined;
  if (batData?.percentage != null) {
   batPct = Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100);
  }
 }

 // 위치: 서버 병합값(amcl_pose DB값) 우선, 없으면 odom 파싱
 let posX: number | null = robot.pose_x ?? null;
 let posY: number | null = robot.pose_y ?? null;
 if (posX === null) {
  const odom = rosMessages[`/${robot_id}/odom`]?.data as {
   pose?: { pose?: { position?: { x?: number; y?: number } } }
  } | undefined;
  posX = odom?.pose?.pose?.position?.x ?? null;
  posY = odom?.pose?.pose?.position?.y ?? null;
 }

 return (
  <button
   onClick={() => onSelect(robot_id)}
   className={`w-full text-left p-3 rounded-xl transition-all duration-300 border ${
    selected
     ? "bg-orange-500/10 border-orange-500/25 shadow-md shadow-orange-500/5"
     : "border-transparent bg-transparent hover:bg-[#FFCE99]/32 hover:border-white/[0.1]"
   }`}
  >
   <div className="flex items-center justify-between mb-2">
    <div className="flex items-center gap-2 min-w-0">
     <div className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[status] ?? "bg-white/15"}`} />
     <span className={`text-xs font-semibold truncate ${selected ? "text-orange-700" : "text-white/65"}`}>
      {robot_id}
     </span>
    </div>
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-[#FFCE99]/32
                      border border-white/[0.08] ${STATUS_COLOR[status] ?? "text-white/[0.45]"}`}>
     {status}
    </span>
   </div>

   {isOnline && batPct !== null && (
    <div className="flex items-center gap-2 pl-3.5">
     <div className="flex-1 h-0.5 bg-[#FFCE99]/32 rounded-full overflow-hidden">
      <div
       className={`h-full rounded-full transition-all duration-1000 ${
        batPct < 20 ? "bg-red-500" : batPct < 50 ? "bg-orange-500" : "bg-emerald-500"
       }`}
       style={{ width: `${batPct}%` }}
      />
     </div>
     <span className={`text-[10px] font-bold ${
      batPct < 20 ? "text-red-600" : batPct < 50 ? "text-orange-600" : "text-white/[0.6]"
     }`}>{batPct}%</span>
    </div>
   )}

   {isOnline && posX !== null && (
    <div className="flex justify-between text-[10px] text-white/[0.5] mt-1.5 pl-3.5">
     <span className="font-semibold tracking-wide">POS</span>
     <span>{posX.toFixed(2)}, {(posY ?? 0).toFixed(2)}</span>
    </div>
   )}
  </button>
 );
}
