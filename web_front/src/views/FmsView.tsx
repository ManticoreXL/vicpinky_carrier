import { useMemo } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, FmsTask, TaskManagerAlert, RobotInfo } from "../hooks/useNestSocket";
import NavMapCanvas from "../components/NavMapCanvas";
import { type RobotPos } from "../components/TopologyMapView";
import { OPERATIONAL_ROBOTS } from "../robots";

interface Props {
 rosMessages: Record<string, RosMessage>;
 fmsTasks: FmsTask[];
 tmAlerts: TaskManagerAlert[];
 socket: Socket | null;
 emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 setRobotHome: (robotId: string, x: number, y: number, yaw: number) => void;
 emitNodeLock: (nodeId: string, isLocked: boolean) => void;
 lockedNodes?: Set<string>;
 robots?: RobotInfo[];
 robotStatuses?: Record<string, string>;
}

// 태스크 등록/할당은 상단 글로벌 태스크 큐가 담당한다. 이 화면은 지도·로봇 현황만 표시.
export default function FmsView({
 rosMessages, fmsTasks, tmAlerts, socket,
 emitNavInitialPose,
 setRobotHome,
 emitNodeLock,
 lockedNodes = new Set(),
 robots = [],
 robotStatuses = {},
}: Props) {
 // 맵 선택/배정과 맵별 마커 필터링은 NavMapCanvas가 자체적으로 담당한다(단일 소스).

 const activePaths = useMemo(() =>
  fmsTasks
   .filter(t => (t.status === "RUNNING" || t.status === "ASSIGNED") && t.assignedRobotId && t.pathQueue?.length)
   .map(t => ({
    robotId: t.assignedRobotId!,
    pathQueue: t.pathQueue ?? [],
    fullPath: t.fullPath,
    taskType: t.type, // 백엔드 원본 타입 그대로 — 토폴로지로 CHARGE 추론 안 함
   })),
 [fmsTasks]);

 // 로봇 좌표 — 라이브 텔레메트리(amcl→odom) 우선, 없으면 DB pose 폴백.
 // 운영 지도에는 가상 테스트봇을 표시하지 않는다(OPERATIONAL_ROBOTS = 테스트봇 제외).
 const robotPositions = useMemo(() => {
 const result: Record<string, RobotPos> = {};
 OPERATIONAL_ROBOTS.forEach(r => {
  // AMCL 우선 (맵 프레임 — 좌표계 일치)
  const amcl = rosMessages[`/${r.id}/amcl_pose`]?.data as any;
  const amclPos = amcl?.pose?.pose?.position;
  if (amclPos?.x != null) { result[r.id] = { x: amclPos.x, y: amclPos.y }; return; }
  // odom 폴백 (odom 프레임 — 근사치, TF 없이도 동작)
  const odom = rosMessages[`/${r.id}/odom`]?.data as any;
  const odomPos = odom?.pose?.pose?.position;
  if (odomPos?.x != null) { result[r.id] = { x: odomPos.x, y: odomPos.y }; return; }
  // DB pose 폴백 (초기위치 설정값 — 텔레메트리 미수신 로봇도 표시)
  const dbInfo = robots.find(ri => ri.robot_id === r.id);
  if (dbInfo?.pose_x != null && dbInfo?.pose_y != null) {
   result[r.id] = { x: dbInfo.pose_x, y: dbInfo.pose_y };
  }
 });
 return result;
 }, [rosMessages, robots]);

 // 맵별 필터링은 NavMapCanvas가 선택된 맵(selectedMap)+배정(assignments) 기준으로 단일 수행한다.
 // (여기서 mapId로 또 거르면 캔버스의 선택 맵과 어긋나 다른 맵 마커가 남거나 빠진다)

 return (
 <div className="flex flex-col h-full bg-transparent overflow-hidden">

 {/* ── 지도 (전체화면) — 상단 바/토글/로봇목록 모두 제거 ── */}
 <div className="flex-1 flex flex-col overflow-hidden bg-[#FFCE99]/32">
 <NavMapCanvas
 rosMessages={rosMessages} socket={socket} onSetInitialPose={emitNavInitialPose} onSetHome={setRobotHome}
 activePaths={activePaths} robotPositions={robotPositions} robots={robots} lockedNodes={lockedNodes}
 onNodeLockToggle={n => emitNodeLock(n, !lockedNodes.has(n))}
 />
 </div>
 </div>
 );
}
