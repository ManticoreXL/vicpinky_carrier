import { useEffect, useState, useCallback } from "react";
import { SubscribeFn } from "../hooks/useRos";
import type { RosMessage } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { useThrottled } from "../hooks/useThrottled";

interface DbRobot {
 robot_id: string;
 ip: string;
 ros_domain_id: number;
 status: "IDLE" | "MOVING" | "WORKING" | "ERROR" | "OFFLINE";
 location?: string | null;
}

interface UrdfInfo {
 modelName: string;
 linkCount: number;
 jointCount: number;
 jointNames: string[];
}

function parseUrdf(xmlStr: string): UrdfInfo | null {
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
 jointNames: joints.map(j => j.getAttribute("name") ?? "").filter(Boolean).slice(0, 4),
 };
 } catch { return null; }
}

const STATUS_COLOR: Record<string, string> = {
 IDLE: "text-white/50",
 MOVING: "text-orange-400",
 WORKING: "text-amber-400",
 ERROR: "text-red-400",
 OFFLINE: "text-white/20",
};

const STATUS_DOT: Record<string, string> = {
 IDLE: "bg-white/30",
 MOVING: "bg-orange-500 animate-pulse",
 WORKING: "bg-amber-500 animate-pulse",
 ERROR: "bg-red-500",
 OFFLINE: "bg-white/10",
};

interface Props {
 subscribe: SubscribeFn;
 selectedRobot: string;
 onSelect: (id: string) => void;
 rosMessages: Record<string, RosMessage>;
 liveStatuses?: Record<string, string>;
}

export default function RobotSidebar({
 subscribe, selectedRobot, onSelect, rosMessages, liveStatuses = {},
}: Props) {
 const [dbRobots, setDbRobots] = useState<DbRobot[]>([]);

 const fetchRobots = useCallback(async () => {
 try {
 const r = await fetch(`${BACKEND_URL}/api/fleet/robots`);
 if (r.ok) setDbRobots(await r.json() as DbRobot[]);
 } catch {}
 }, []);

 useEffect(() => {
 void fetchRobots();
 const t = setInterval(() => void fetchRobots(), 10_000);
 return () => clearInterval(t);
 }, [fetchRobots]);

 useEffect(() => {
 const subs: (ReturnType<SubscribeFn> | null)[] = [];
 dbRobots.forEach(({ robot_id }) => {
 subs.push(subscribe<{ data: string }>(
 `/${robot_id}/robot_description`, "std_msgs/String", () => {},
 ));
 });
 return () => subs.forEach(s => s?.unsubscribe());
 }, [subscribe, dbRobots]);

 const displayMessages = useThrottled(rosMessages, 800);

 return (
 <aside className="w-56 sm:w-60 flex-none glass-panel border-r border-white/[0.05] flex flex-col overflow-y-auto">
 <div className="px-4 py-4 border-b border-white/[0.05]">
 <span className="sub-label">Fleet</span>
 <div className="flex items-center justify-between mt-1">
 <span className="text-sm font-semibold text-white/80 tracking-widest uppercase">Units</span>
 <span className="px-1.5 py-0.5 bg-orange-500/10 rounded text-[10px] text-orange-400 font-bold
                  border border-orange-500/20">{dbRobots.length}</span>
 </div>
 </div>

 <div className="flex-1 overflow-y-auto p-3 space-y-1">
 {dbRobots.length === 0 ? (
 <p className="px-3 py-8 text-xs text-white/15 text-center italic">스캔 중...</p>
 ) : (
 dbRobots.map(robot => (
 <RobotItem
 key={robot.robot_id}
 robot={robot}
 selected={selectedRobot === robot.robot_id}
 onSelect={onSelect}
 rosMessages={displayMessages}
 liveStatus={liveStatuses[robot.robot_id]}
 />
 ))
 )}
 </div>
 </aside>
 );
}

const ONLINE_THRESHOLD_MS = 5000;

function RobotItem({
 robot, selected, onSelect, rosMessages, liveStatus,
}: {
 robot: DbRobot;
 selected: boolean;
 onSelect: (id: string) => void;
 rosMessages: Record<string, RosMessage>;
 liveStatus?: string;
}) {
 const { robot_id } = robot;
 const p = (topic: string) => rosMessages[`/${robot_id}/${topic}`]?.data;

 const odomTs = rosMessages[`/${robot_id}/odom`]?.timestamp ?? 0;
 const isOnline = odomTs > 0 && Date.now() - odomTs < ONLINE_THRESHOLD_MS;

 const batData = p("battery_state") as { percentage?: number } | undefined;
 const batPct = batData?.percentage != null
 ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
 : null;

 const odom = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number } } } } | undefined;
 const pos = odom?.pose?.pose?.position;

 const rdRaw = p("robot_description") as { data?: string } | string | undefined;
 const rdStr = typeof rdRaw === "string" ? rdRaw
 : (rdRaw as { data?: string } | undefined)?.data ?? null;
 const urdf = rdStr ? parseUrdf(rdStr) : null;

 const displayStatus = (liveStatus ?? robot.status) as string;

 return (
 <button
 onClick={() => onSelect(robot_id)}
 className={`w-full text-left p-3 rounded-xl transition-all duration-300 border ${
 selected
   ? "bg-orange-500/10 border-orange-500/25 shadow-md shadow-orange-500/5"
   : "border-transparent bg-transparent hover:bg-white/[0.03] hover:border-white/[0.05]"
 }`}
 >
 <div className="flex items-center justify-between mb-2">
 <div className="flex items-center gap-2 min-w-0">
 <div className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[displayStatus] ?? "bg-white/15"}`} />
 <span className={`text-xs font-semibold truncate ${selected ? "text-orange-300" : "text-white/65"}`}>
 {robot_id}
 </span>
 </div>
 <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-black/35
                   border border-white/[0.04] ${STATUS_COLOR[displayStatus] ?? "text-white/20"}`}>
 {displayStatus}
 </span>
 </div>

 {urdf && (
 <p className="text-[10px] text-white/30 truncate mb-2 pl-3.5">{urdf.modelName}</p>
 )}

 {isOnline && batPct !== null && (
 <div className="flex items-center gap-2 pl-3.5">
 <div className="flex-1 h-0.5 bg-white/[0.06] rounded-full overflow-hidden">
 <div
 className={`h-full rounded-full transition-all duration-1000 ${
   batPct < 20 ? "bg-red-500" : batPct < 50 ? "bg-orange-500" : "bg-emerald-500"
 }`}
 style={{ width: `${batPct}%` }}
 />
 </div>
 <span className={`text-[10px] font-bold ${
   batPct < 20 ? "text-red-400" : batPct < 50 ? "text-orange-400" : "text-white/40"
 }`}>{batPct}%</span>
 </div>
 )}

 {isOnline && pos?.x != null && (
 <div className="flex justify-between text-[10px] text-white/25 mt-1.5 pl-3.5">
 <span className="font-semibold tracking-wide">POS</span>
 <span>{pos.x.toFixed(2)}, {(pos.y ?? 0).toFixed(2)}</span>
 </div>
 )}
 </button>
 );
}
