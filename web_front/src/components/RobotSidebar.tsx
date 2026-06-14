import { useEffect, useState, useCallback } from "react";
import { SubscribeFn } from "../hooks/useRos";
import type { RosMessage } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { useThrottled } from "../hooks/useThrottled";

// ── 타입 ─────────────────────────────────────────────────────────────────────

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

// ── URDF XML 파서 ─────────────────────────────────────────────────────────────

function parseUrdf(xmlStr: string): UrdfInfo | null {
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
      jointNames: joints.map(j => j.getAttribute("name") ?? "").filter(Boolean).slice(0, 4),
    };
  } catch { return null; }
}

// ── 상태 색상 ─────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  IDLE:    "bg-green-500",
  MOVING:  "bg-blue-400 animate-pulse",
  WORKING: "bg-yellow-400 animate-pulse",
  ERROR:   "bg-red-500",
  OFFLINE: "bg-[#333]",
};

const STATUS_TEXT: Record<string, string> = {
  IDLE:    "text-green-500",
  MOVING:  "text-blue-400",
  WORKING: "text-yellow-400",
  ERROR:   "text-red-500",
  OFFLINE: "text-[#333]",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  subscribe:     SubscribeFn;
  selectedRobot: string;
  onSelect:      (id: string) => void;
  rosMessages:   Record<string, RosMessage>;
  liveStatuses?: Record<string, string>;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

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

  // 초기 로드 + 10초마다 갱신
  useEffect(() => {
    void fetchRobots();
    const t = setInterval(() => void fetchRobots(), 10_000);
    return () => clearInterval(t);
  }, [fetchRobots]);

  // DB 로봇에 대해 robot_description + 배터리 rosbridge 구독
  useEffect(() => {
    const subs: (ReturnType<SubscribeFn> | null)[] = [];
    dbRobots.forEach(({ robot_id }) => {
      // robot_description은 NestJS rosMessages에서 읽음; rosbridge로도 구독해 둠
      subs.push(subscribe<{ data: string }>(
        `/${robot_id}/robot_description`, "std_msgs/String", () => {},
      ));
    });
    return () => subs.forEach(s => s?.unsubscribe());
  }, [subscribe, dbRobots]);

  const displayMessages = useThrottled(rosMessages, 800);

  return (
    <aside className="w-52 flex-none bg-[#080808] border-r border-red-900/30 flex flex-col overflow-y-auto">
      {/* 헤더 */}
      <div className="px-3 pt-3 pb-1.5 border-b border-[#111]">
        <p className="text-[9px] font-bold text-red-900/60 uppercase tracking-[0.3em] flex items-center gap-1">
          <span className="w-3 h-px bg-red-900/50" />
          ROBOT FLEET
          <span className="ml-auto text-[#333]">{dbRobots.length}</span>
        </p>
      </div>

      {/* 로봇 목록 */}
      <div className="flex-1 overflow-y-auto py-1">
        {dbRobots.length === 0 ? (
          <p className="px-3 py-4 text-[9px] text-[#2a2a2a] font-mono text-center">DB에 로봇 없음</p>
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

// ── 로봇 카드 ─────────────────────────────────────────────────────────────────

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

  // 배터리
  const batData = p("battery_state") as { percentage?: number } | undefined;
  const batPct  = batData?.percentage != null
    ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
    : null;

  // 위치
  const odom = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number } } } } | undefined;
  const pos  = odom?.pose?.pose?.position;

  // URDF
  const rdRaw  = p("robot_description") as { data?: string } | string | undefined;
  const rdStr  = typeof rdRaw === "string" ? rdRaw
               : (rdRaw as { data?: string } | undefined)?.data ?? null;
  const urdf   = rdStr ? parseUrdf(rdStr) : null;

  // 실시간 상태 (socket > DB 순)
  const displayStatus = (liveStatus ?? robot.status) as keyof typeof STATUS_DOT;

  return (
    <button
      onClick={() => onSelect(robot_id)}
      className={`w-full text-left px-2.5 py-2 mb-0.5 transition-all border-l-2 ${
        selected
          ? "bg-red-950/30 border-red-600 shadow-sm shadow-red-900/30"
          : "border-transparent hover:bg-[#111] hover:border-red-900/40"
      }`}
    >
      {/* 헤더 행: dot + ID + 상태 */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[displayStatus] ?? "bg-[#333]"}`} />
        <span className={`text-[11px] font-black tracking-widest uppercase font-mono flex-1 truncate ${
          selected ? "text-[#c0c0c0]" : "text-[#555]"
        }`}>{robot_id}</span>
        <span className={`text-[8px] font-mono font-bold ${STATUS_TEXT[displayStatus] ?? "text-[#333]"}`}>
          {displayStatus}
        </span>
      </div>

      {/* URDF 정보 카드 */}
      {urdf ? (
        <div className="ml-3 mb-1 px-2 py-1 bg-[#0d1a0d] border border-green-900/30 rounded-sm">
          <div className="flex items-center gap-1 mb-0.5">
            <span className="text-[8px] text-green-600 font-bold uppercase tracking-wider">URDF</span>
            <span className="text-[9px] font-mono text-green-400 truncate">{urdf.modelName}</span>
          </div>
          <div className="flex gap-2 text-[8px] font-mono text-[#555]">
            <span><span className="text-[#888]">{urdf.linkCount}</span> links</span>
            <span><span className="text-[#888]">{urdf.jointCount}</span> joints</span>
          </div>
          {urdf.jointNames.length > 0 && (
            <div className="mt-0.5 text-[7px] font-mono text-[#333] truncate">
              {urdf.jointNames.join(" · ")}{urdf.jointCount > 4 ? " …" : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="ml-3 mb-1 flex items-center gap-1">
          <span className="text-[8px] font-mono text-[#2a2a2a]">URDF 대기 중</span>
        </div>
      )}

      {/* 센서 데이터 */}
      <div className="ml-3 flex flex-col gap-0.5">
        {batPct !== null && <BatteryRow pct={batPct} />}
        {pos?.x != null && (
          <div className="flex justify-between text-[9px] font-mono">
            <span className="text-[#333]">POS</span>
            <span className="text-[#666]">{(pos.x ?? 0).toFixed(2)}, {(pos.y ?? 0).toFixed(2)}</span>
          </div>
        )}
        {robot.location && (
          <div className="flex justify-between text-[9px] font-mono">
            <span className="text-[#333]">NODE</span>
            <span className="text-[#555] truncate max-w-[80px]">{robot.location}</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── 배터리 행 ─────────────────────────────────────────────────────────────────

function BatteryRow({ pct }: { pct: number }) {
  const color = pct < 20 ? "text-red-500" : pct < 50 ? "text-amber-400" : "text-green-500";
  const barW  = `${Math.max(4, pct)}%`;
  const barC  = pct < 20 ? "bg-red-600" : pct < 50 ? "bg-amber-500" : "bg-green-600";
  return (
    <div className="flex items-center gap-1.5 text-[9px] font-mono">
      <span className="text-[#333]">BAT</span>
      <div className="flex-1 h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barC}`} style={{ width: barW }} />
      </div>
      <span className={`font-bold ${color}`}>{pct}%</span>
    </div>
  );
}
