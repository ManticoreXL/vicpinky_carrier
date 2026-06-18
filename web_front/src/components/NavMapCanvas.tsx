import { useEffect, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import CameraFeed from "./CameraFeed";
import { snapNodes } from "./TopologyMapView";
import type { FNode, FEdge, ActivePath, RobotPos } from "./TopologyMapView";

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface StaticMapInfo {
 resolution: number;
 width: number;
 height: number;
 originX: number;
 originY: number;
 snapThreshold?: number;
}

const TB3_ROBOTS = [
 { id: "tb3_01", label: "TB3-01", color: "#3b82f6" },
 { id: "tb3_02", label: "TB3-02", color: "#10b981" },
 { id: "tb3_03", label: "TB3-03", color: "#f59e0b" },
 { id: "tb3_04", label: "TB3-04", color: "#8b5cf6" },
] as const;

const NODE_COLOR: Record<string, string> = {
 WAYPOINT: "#60a5fa",
 STATION: "#fbbf24",
 CHARGER: "#4ade80",
};

const ROBOT_COLORS = ["#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#38bdf8"];
// 충전 임무 경로 전용 색 (충전소 노드와 동일 계열 녹색 — 일반 주행 경로와 구분)
const CHARGE_PATH_COLOR = "#22c55e";

// ── 좌표 변환 ─────────────────────────────────────────────────────────────────

function worldToCanvas(wx: number, wy: number, info: StaticMapInfo, scale: number) {
 const col = (wx - info.originX) / info.resolution;
 const row = (info.height - 1) - (wy - info.originY) / info.resolution;
 return { cx: col * scale, cy: row * scale };
}

function canvasToWorld(cx: number, cy: number, info: StaticMapInfo, scale: number) {
 const col = cx / scale;
 const row = cy / scale;
 return {
 wx: info.originX + col * info.resolution,
 wy: info.originY + (info.height - 1 - row) * info.resolution,
 };
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
 const l2 = (x2 - x1)**2 + (y2 - y1)**2;
 if (l2 === 0) return Math.hypot(px - x1, py - y1);
 let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
 t = Math.max(0, Math.min(1, t));
 return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
 return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
 rosMessages: Record<string, RosMessage>;
 socket: Socket | null;
 onSetInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 onSetHome?: (robotId: string, x: number, y: number, yaw: number) => void;
 activePaths?: ActivePath[];
 robotPositions?: Record<string, RobotPos>;
 onNodeClick?: (nodeId: string) => void;
 lockedNodes?: Set<string>;
}

interface DragState {
 sx: number; sy: number;
 cx: number; cy: number;
 type: "goal" | "pose" | "home";
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function NavMapCanvas({
 rosMessages, socket, onSetInitialPose, onSetHome,
 activePaths = [], robotPositions = {}, onNodeClick, lockedNodes = new Set(),
}: Props) {
 const canvasRef = useRef<HTMLCanvasElement>(null);
 const wrapRef = useRef<HTMLDivElement>(null);
 const imgRef = useRef<HTMLImageElement | null>(null);
 const infoRef = useRef<StaticMapInfo | null>(null);
 const scaleRef = useRef(1);
 const dragRef = useRef<DragState | null>(null);

 // topology refs — don't add to draw deps
 const topoNodesRef = useRef<FNode[]>([]);
 const topoEdgesRef = useRef<FEdge[]>([]);
 const activePathsRef = useRef<ActivePath[]>(activePaths);
 const robotPosRef = useRef<Record<string, RobotPos>>(robotPositions);
 const onNodeClickRef = useRef(onNodeClick);
 const lockedNodesRef = useRef<Set<string>>(lockedNodes);
 const assignmentsRef = useRef<Record<string, string>>({});
 const selectedMapRef = useRef<string>("");
 const drawRef = useRef<() => void>(() => {});

 const [availableMaps, setAvailableMaps] = useState<string[]>([]);
 const [selectedMap, setSelectedMap] = useState<string>("");
 const [assignments, setAssignments] = useState<Record<string, string>>({});
 const [assignLoading, setAssignLoading] = useState(false);
 const [mapInfo, setMapInfo] = useState<StaticMapInfo | null>(null);
 const [canvasReady, setCanvasReady] = useState(false);
 const [interactive, setInteractive] = useState(true);
 const [homeMode, setHomeMode] = useState(false);
 const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set(["tb3_01"]));
 const [showCamera, setShowCamera] = useState(true);
 const [showTopology, setShowTopology] = useState(true);
 const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
 const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
 const [topoStats, setTopoStats] = useState({ n: 0, e: 0 });

 const base = BACKEND_URL.replace(/\/$/, "");

 // keep refs in sync
 useEffect(() => { activePathsRef.current = activePaths; drawRef.current(); }, [activePaths]);
 useEffect(() => { robotPosRef.current = robotPositions; }, [robotPositions]);
 useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);
 useEffect(() => { lockedNodesRef.current = lockedNodes; drawRef.current(); }, [lockedNodes]);
 useEffect(() => { assignmentsRef.current = assignments; }, [assignments]);
 useEffect(() => { selectedMapRef.current = selectedMap; }, [selectedMap]);

 // ── 맵 목록 + 할당 로드 ──────────────────────────────────────────────────

 useEffect(() => {
 Promise.all([
 fetch(`${base}/api/map/static/list`).then((r) => r.json() as Promise<string[]>),
 fetch(`${base}/api/map/assignments`).then((r) => r.json() as Promise<Record<string, string>>),
 ])
 .then(([list, asgn]) => {
 setAvailableMaps(list);
 setAssignments(asgn);
 const initial = asgn["tb3_01"] ?? list[0] ?? "";
 if (initial) setSelectedMap(initial);
 })
 .catch(console.error);
 }, [base]);

 // ── 선택 로봇 변경 시 해당 로봇의 할당 맵으로 전환 ─────────────────────

 useEffect(() => {
 const firstBot = [...selectedBots][0];
 if (!firstBot || !assignments[firstBot]) return;
 const assignedMap = assignments[firstBot];
 if (assignedMap !== selectedMap) setSelectedMap(assignedMap);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [selectedBots, assignments]);

 // ── 선택된 맵 로드 (정적 맵 + 토폴로지) ────────────────────────────────

 useEffect(() => {
 if (!selectedMap) {
 infoRef.current = null;
 imgRef.current = null;
 topoNodesRef.current = [];
 topoEdgesRef.current = [];
 setMapInfo(null);
 setCanvasReady(false);
 setTopoStats({ n: 0, e: 0 });
 return;
 }

 setCanvasReady(false);
 imgRef.current = null;
 infoRef.current = null;
 topoNodesRef.current = [];
 topoEdgesRef.current = [];

 // 정적 맵 info + image
 fetch(`${base}/api/map/static/${selectedMap}/info`)
 .then((r) => r.json())
 .then((info: StaticMapInfo) => {
 infoRef.current = info;
 setMapInfo(info);
 drawRef.current();

 // 토폴로지 로드
 Promise.all([
 fetch(`${base}/api/fleet/topology/nodes?map_id=${selectedMap}`)
 .then(r => r.json()).catch(() => []),
 fetch(`${base}/api/fleet/topology/edges`)
 .then(r => r.json()).catch(() => []),
 ]).then(([ns, es]) => {
 const nodes = Array.isArray(ns) ? ns as FNode[] : [];
 const snappedNodes = snapNodes(nodes, info.snapThreshold ?? 0.25);
 const nodeIds = new Set(snappedNodes.map(n => n.node_id));
 const allEdges = Array.isArray(es) ? es as FEdge[] : [];
 const edges = allEdges.filter(e => nodeIds.has(e.startNode) && nodeIds.has(e.endNode));
 topoNodesRef.current = snappedNodes;
 topoEdgesRef.current = edges;
 setTopoStats({ n: snappedNodes.length, e: edges.length });
 drawRef.current();
 });
 })
 .catch(console.error);

 const img = new Image();
 img.onload = () => { imgRef.current = img; setCanvasReady(true); };
 img.onerror = () => { setCanvasReady(true); }; // show dark bg + topology
 img.src = `${base}/api/map/static/${selectedMap}/image`;
 }, [selectedMap, base]);

 // ── 캔버스 렌더 ───────────────────────────────────────────────────────────

 const draw = useCallback(() => {
 const canvas = canvasRef.current;
 const info = infoRef.current;
 if (!canvas || !info) return;

 const wrap = wrapRef.current;
 const ww = wrap?.clientWidth ?? 600;
 const wh = wrap?.clientHeight ?? 400;
 const scale = Math.min(ww / info.width, wh / info.height);
 scaleRef.current = scale;

 canvas.width = Math.floor(info.width * scale);
 canvas.height = Math.floor(info.height * scale);

 const ctx = canvas.getContext("2d")!;
 ctx.imageSmoothingEnabled = false;

 // 배경
 const img = imgRef.current;
 if (img) {
 ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
 } else {
 ctx.fillStyle = "#241509";
 ctx.fillRect(0, 0, canvas.width, canvas.height);
 }

 // ── 경로 그리기 (현재 맵에 배정된 로봇만) ───────────────────────────
 for (const robot of TB3_ROBOTS) {
 const robotAssignedMap = assignmentsRef.current[robot.id];
 if (robotAssignedMap && robotAssignedMap !== selectedMapRef.current) continue;
 const planData = rosMessages[`/${robot.id}/plan`]?.data as {
 poses?: Array<{ pose?: { position?: { x?: number; y?: number } } }>
 } | undefined;
 const poses = planData?.poses;
 if (!poses?.length) continue;
 const isSelected = selectedBots.has(robot.id);

 ctx.beginPath();
 let started = false;
 for (const p of poses) {
 const pos = p?.pose?.position;
 if (pos?.x == null) continue;
 const { cx, cy } = worldToCanvas(pos.x, pos.y ?? 0, info, scale);
 if (!started) { ctx.moveTo(cx, cy); started = true; }
 else ctx.lineTo(cx, cy);
 }
 ctx.strokeStyle = robot.color + (isSelected ? "dd" : "55");
 ctx.lineWidth = isSelected ? 2.5 : 1.2;
 ctx.setLineDash(isSelected ? [4, 3] : [2, 3]);
 ctx.stroke();
 ctx.setLineDash([]);

 const last = poses[poses.length - 1]?.pose?.position;
 if (last?.x != null) {
 const { cx, cy } = worldToCanvas(last.x, last.y ?? 0, info, scale);
 ctx.beginPath();
 ctx.arc(cx, cy, isSelected ? 7 : 4, 0, Math.PI * 2);
 ctx.fillStyle = robot.color + (isSelected ? "44" : "22");
 ctx.fill();
 ctx.strokeStyle = robot.color + (isSelected ? "ee" : "66");
 ctx.lineWidth = isSelected ? 2 : 1;
 ctx.stroke();
 }
 }

 // ── 활성 경로 맵 (맵 배정 로봇 필터링) ──────────────────────────────
 const robotColorMap: Record<string, string> = {};
 const filteredApaths = activePathsRef.current.filter(({ robotId }) => {
 const assigned = assignmentsRef.current[robotId];
 return !assigned || assigned === selectedMapRef.current;
 });
 filteredApaths.forEach(({ robotId, taskType }, i) => {
 // 충전 임무는 전용 색, 그 외는 로봇별 색 순환
 robotColorMap[robotId] = taskType === "CHARGE" ? CHARGE_PATH_COLOR : ROBOT_COLORS[i % ROBOT_COLORS.length];
 });

 // ── 토폴로지 오버레이 ─────────────────────────────────────────────────

 if (showTopology) {
 const topoNodes = topoNodesRef.current;
 const topoEdges = topoEdgesRef.current;
 const robPos = robotPosRef.current;

 // active 경로 맵 구성
 const activeNodeMap: Record<string, string> = {};
 const activeEdgeMap: Record<string, string> = {};
 filteredApaths.forEach(({ robotId, pathQueue, fromNodeId }) => {
 if (fromNodeId) activeNodeMap[fromNodeId] = robotId;
 pathQueue.forEach(id => { activeNodeMap[id] = robotId; });
 const full = fromNodeId ? [fromNodeId, ...pathQueue] : pathQueue;
 for (let j = 0; j < full.length - 1; j++) {
 activeEdgeMap[`${full[j]}→${full[j + 1]}`] = robotId;
 }
 });

 // 엣지 렌더 — 가중치 기반 두께 + 검정 아웃라인으로 SLAM 맵 배경에서 선명하게
 topoEdges.forEach(e => {
 const sn = topoNodes.find(n => n.node_id === e.startNode);
 const en = topoNodes.find(n => n.node_id === e.endNode);
 if (!sn || !en) return;

 const { cx: sx, cy: sy } = worldToCanvas(sn.x, sn.y, info, scale);
 const { cx: ex, cy: ey } = worldToCanvas(en.x, en.y, info, scale);

 const fwdKey = `${e.startNode}→${e.endNode}`;
 const bwdKey = `${e.endNode}→${e.startNode}`;
 const ar = activeEdgeMap[fwdKey] ?? activeEdgeMap[bwdKey];
 const w = e.weight ?? 1;
 const isBlocked = w <= 0.1;
 const isLow = w < 1;

 const baseLw = ar ? Math.min(6, 2 + w) : isBlocked ? 2 : Math.max(2, Math.min(6, 1 + w * 1.5));

 let lineColor: string;
 if (ar) lineColor = robotColorMap[ar];
 else if (e.isLocked) lineColor = "#f87171";
 else if (isBlocked) lineColor = "#6b7280";
 else if (isLow) lineColor = "#6ee7b7";
 else lineColor = "#22d3ee";

 ctx.save();

 // 진입 불가 엣지: 파선으로 표시
 if (isBlocked) {
 ctx.setLineDash([5, 5]);
 ctx.globalAlpha = 0.45;
 } else if (isLow && !ar) {
 ctx.setLineDash([8, 4]);
 ctx.globalAlpha = 0.7;
 } else {
 ctx.globalAlpha = 1;
 }

 // 1단계: 검정 아웃라인 — 밝은 맵 배경에서도 보이도록
 ctx.beginPath();
 ctx.moveTo(sx, sy);
 ctx.lineTo(ex, ey);
 ctx.strokeStyle = "rgba(0,0,0,0.75)";
 ctx.lineWidth = baseLw + 3;
 ctx.stroke();

 // 2단계: 색상 선
 ctx.beginPath();
 ctx.moveTo(sx, sy);
 ctx.lineTo(ex, ey);
 ctx.strokeStyle = lineColor;
 ctx.lineWidth = baseLw;
 ctx.stroke();

 ctx.setLineDash([]);
 ctx.globalAlpha = 1;

 // 가중치 숫자 라벨 (w != 1 일 때만 중앙에 표시)
 if (!isBlocked && w !== 1) {
 const mx = (sx + ex) / 2, my = (sy + ey) / 2;
 ctx.font = "bold 8px monospace";
 ctx.textAlign = "center";
 ctx.textBaseline = "middle";
 ctx.strokeStyle = "rgba(0,0,0,0.9)";
 ctx.lineWidth = 3;
 ctx.strokeText(`w${w}`, mx, my - baseLw - 3);
 ctx.fillStyle = lineColor;
 ctx.fillText(`w${w}`, mx, my - baseLw - 3);
 }

 // ONE_WAY 방향 화살표 (중간 지점)
 if (e.direction === "ONE_WAY") {
 const angle = Math.atan2(ey - sy, ex - sx);
 const mx = (sx + ex) / 2, my = (sy + ey) / 2;
 const al = ar ? 12 : 10;
 ctx.beginPath();
 ctx.moveTo(mx + al * 0.3 * Math.cos(angle), my + al * 0.3 * Math.sin(angle));
 ctx.lineTo(mx - al * Math.cos(angle - 0.42), my - al * Math.sin(angle - 0.42));
 ctx.lineTo(mx - al * Math.cos(angle + 0.42), my - al * Math.sin(angle + 0.42));
 ctx.closePath();
 ctx.fillStyle = "rgba(0,0,0,0.75)";
 ctx.fill();
 const al2 = al - 2;
 ctx.beginPath();
 ctx.moveTo(mx + al2 * 0.3 * Math.cos(angle), my + al2 * 0.3 * Math.sin(angle));
 ctx.lineTo(mx - al2 * Math.cos(angle - 0.42), my - al2 * Math.sin(angle - 0.42));
 ctx.lineTo(mx - al2 * Math.cos(angle + 0.42), my - al2 * Math.sin(angle + 0.42));
 ctx.closePath();
 ctx.fillStyle = lineColor;
 ctx.fill();
 }

 // 활성 엣지 로봇 라벨
 const labelRobot = ar ?? null;
 const labelColor = ar ? robotColorMap[ar] : null;
 if (labelRobot && labelColor) {
 const mx = (sx + ex) / 2, my = (sy + ey) / 2;
 ctx.font = "bold 8px monospace";
 ctx.textAlign = "center";
 ctx.textBaseline = "bottom";
 ctx.lineWidth = 3;
 ctx.strokeStyle = "#000";
 ctx.strokeText(labelRobot, mx, my - baseLw - 1);
 ctx.fillStyle = labelColor;
 ctx.fillText(labelRobot, mx, my - baseLw - 1);
 }
 ctx.restore();
 });

 // 노드 렌더
 const lockedSet = lockedNodesRef.current;
 topoNodes.forEach(n => {
 const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
 const ar = activeNodeMap[n.node_id];
 const rc = ar ? robotColorMap[ar] : null;
 const isHov = n.node_id === hoveredNodeId;
 const isLock = lockedSet.has(n.node_id);
 const r = rc ? 9 : isHov ? 8 : 6;

 if (rc) {
 ctx.beginPath();
 ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
 ctx.fillStyle = rc + "33";
 ctx.fill();
 }

 ctx.beginPath();
 ctx.arc(cx, cy, r, 0, Math.PI * 2);
 ctx.fillStyle = isLock ? "#dc2626" : (NODE_COLOR[n.type] ?? "#888");
 ctx.fill();

 if (rc || isHov || isLock) {
 ctx.strokeStyle = isLock ? "#fca5a5" : (rc ?? "#fff");
 ctx.lineWidth = isLock ? 2 : rc ? 2.5 : 1.5;
 ctx.stroke();
 }

 // 잠긴 노드: X 마커
 if (isLock) {
 ctx.save();
 ctx.strokeStyle = "#fff";
 ctx.lineWidth = 1.5;
 const d = r * 0.55;
 ctx.beginPath(); ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d); ctx.stroke();
 ctx.beginPath(); ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d); ctx.stroke();
 ctx.restore();
 }

 // 라벨
 ctx.fillStyle = isLock ? "#fca5a5" : (rc ?? (isHov ? "#fff" : "#ffffffcc"));
 ctx.font = (rc || isLock) ? "bold 9px monospace" : "9px monospace";
 ctx.textAlign = "left";
 ctx.textBaseline = "bottom";
 ctx.fillText(n.node_id, cx + r + 2, cy);
 });

 // 비-TB3 로봇 위치 — amcl_pose 우선(맵 프레임), odom 폴백(근사/점선)
 const tb3IdSet = new Set<string>(TB3_ROBOTS.map(r => r.id));
 const KNOWN_NON_TB3 = ["vicpinky", "omx"];
 const nonTb3Ids = [...new Set([
  ...KNOWN_NON_TB3,
  ...Object.keys(robPos).filter(id => !tb3IdSet.has(id)),
 ])];
 nonTb3Ids.forEach((robotId, i) => {
  const color = ROBOT_COLORS[i % ROBOT_COLORS.length];

  // 1) AMCL (맵 프레임 — 정확)
  const amcl = rosMessages[`/${robotId}/amcl_pose`]?.data as any;
  const amclPos = amcl?.pose?.pose?.position;
  const amclOri = amcl?.pose?.pose?.orientation;

  // 2) odom 폴백 (odom 프레임 — TF 없이 근사)
  const odomData = rosMessages[`/${robotId}/odom`]?.data as any;
  const odomPos  = odomData?.pose?.pose?.position;
  const odomOri  = odomData?.pose?.pose?.orientation;

  let posX: number, posY: number, yaw: number, isApprox: boolean;
  if (amclPos?.x != null) {
   posX = amclPos.x; posY = amclPos.y;
   yaw = amclOri ? quatToYaw(amclOri) : 0;
   isApprox = false;
  } else if (robPos[robotId]) {
   posX = robPos[robotId].x; posY = robPos[robotId].y;
   yaw = odomOri ? quatToYaw(odomOri) : 0;
   isApprox = true;
  } else if (odomPos?.x != null) {
   posX = odomPos.x; posY = odomPos.y;
   yaw = odomOri ? quatToYaw(odomOri) : 0;
   isApprox = true;
  } else {
   return; // 데이터 없음
  }

  const { cx, cy } = worldToCanvas(posX, posY, info, scale);
  const pad = 30;
  if (cx < -pad || cy < -pad || cx > canvas.width + pad || cy > canvas.height + pad) return;

  const r = 7;
  ctx.save();

  // glow
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
  ctx.fillStyle = color + "22";
  ctx.fill();

  // 본체
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color + (isApprox ? "55" : "99");
  ctx.fill();

  // 외곽선 (odom이면 점선)
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (isApprox) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // yaw 방향 화살표
  const arrowLen = r + 10;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(-yaw) * arrowLen, cy + Math.sin(-yaw) * arrowLen);
  ctx.strokeStyle = color;
  ctx.lineWidth = isApprox ? 1.5 : 2;
  ctx.stroke();

  // 라벨 (검정 외곽선으로 SLAM 맵 배경에서 가독성 확보)
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.font = "bold 10px monospace";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(robotId, cx, cy - r - 4);
  ctx.fillStyle = color;
  ctx.fillText(robotId, cx, cy - r - 4);

  // odom 근사 표시
  if (isApprox) {
   ctx.font = "8px monospace";
   ctx.textBaseline = "top";
   ctx.fillStyle = color + "88";
   ctx.strokeStyle = "rgba(0,0,0,0.7)";
   ctx.lineWidth = 2;
   ctx.strokeText("~odom", cx, cy + r + 3);
   ctx.fillText("~odom", cx, cy + r + 3);
  }

  ctx.restore();
 });
 }

 // ── 경로 오버레이: 전체 경로(fullPath) + 현재 goal(pathQueue[0]) 시각화 ──
 for (const { robotId, pathQueue, fullPath } of filteredApaths) {
  const color = robotColorMap[robotId];
  if (!color || pathQueue.length === 0) continue;

  // 로봇 현재 위치 (AMCL)
  const amclMsg = rosMessages[`/${robotId}/amcl_pose`]?.data as any;
  const amclPos = amclMsg?.pose?.pose?.position;
  const robotPt = amclPos?.x != null ? worldToCanvas(amclPos.x, amclPos.y, info, scale) : null;

  type WPt = { cx: number; cy: number; nodeId: string; yaw: number };
  const toWPt = (nodeId: string): WPt | null => {
   const node = topoNodesRef.current.find(n => n.node_id === nodeId);
   return node ? { ...worldToCanvas(node.x, node.y, info, scale), nodeId, yaw: node.yaw ?? 0 } : null;
  };

  // 전체 계획 경로 (fullPath 우선, 없으면 pathQueue로 대체)
  const planIds = (fullPath && fullPath.length > 0) ? fullPath : pathQueue;
  const planPts = planIds.map(toWPt).filter((p): p is WPt => p !== null);
  if (planPts.length === 0) continue;

  // 남은 경로 (pathQueue)
  const remPts = pathQueue.map(toWPt).filter((p): p is WPt => p !== null);

  // 이미 통과한 노드들 (fullPath에는 있지만 pathQueue에 없는 노드)
  const remainSet = new Set(pathQueue);
  const visitedIds = planIds.filter(id => !remainSet.has(id));
  const visitedPts = visitedIds.map(toWPt).filter((p): p is WPt => p !== null);

  const goalPt  = remPts[0];   // 현재 goal_pose 대상
  const finalPt = planPts[planPts.length - 1];
  const isSingle = planPts.length === 1;

  ctx.save();

  // ── 1. 이미 지나온 경로 (방문 완료 구간) ─ 매우 희미하게 ──────────────
  if (visitedPts.length > 0) {
   const visitedLine: WPt[] = [];
   if (robotPt) visitedLine.push({ cx: robotPt.cx, cy: robotPt.cy, nodeId: "", yaw: 0 });
   visitedLine.push(...visitedPts);
   if (goalPt) visitedLine.push(goalPt);
   if (visitedLine.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(visitedLine[0].cx, visitedLine[0].cy);
    for (let i = 1; i < visitedLine.length; i++) ctx.lineTo(visitedLine[i].cx, visitedLine[i].cy);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = 0.2;
    ctx.setLineDash([4, 8]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
   }
  }

  // ── 2. 전체 계획 경로 배경 glow ──────────────────────────────────────
  {
   const glowPts = robotPt ? [{ cx: robotPt.cx, cy: robotPt.cy, nodeId: "", yaw: 0 }, ...planPts] : planPts;
   ctx.beginPath();
   ctx.moveTo(glowPts[0].cx, glowPts[0].cy);
   for (let i = 1; i < glowPts.length; i++) ctx.lineTo(glowPts[i].cx, glowPts[i].cy);
   ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.globalAlpha = 0.08;
   ctx.shadowColor = color; ctx.shadowBlur = 20; ctx.stroke();
   ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  // ── 3. 로봇 → 현재 GOAL : solid 선 + glow ────────────────────────────
  if (robotPt && goalPt) {
   ctx.beginPath();
   ctx.moveTo(robotPt.cx, robotPt.cy); ctx.lineTo(goalPt.cx, goalPt.cy);
   ctx.strokeStyle = color; ctx.lineWidth = 3.5; ctx.globalAlpha = 1;
   ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
  }

  // ── 4. GOAL 이후 전체 계획 경로 : dashed ─────────────────────────────
  if (planPts.length > 1) {
   const startIdx = goalPt ? planPts.findIndex(p => p.nodeId === goalPt.nodeId) : 0;
   if (startIdx >= 0 && startIdx < planPts.length - 1) {
    ctx.beginPath();
    ctx.moveTo(planPts[startIdx].cx, planPts[startIdx].cy);
    for (let i = startIdx + 1; i < planPts.length; i++) ctx.lineTo(planPts[i].cx, planPts[i].cy);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.5;
    ctx.setLineDash([10, 6]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
   }
  }

  // ── 5. 방향 화살표 ────────────────────────────────────────────────────
  {
   const arPts = robotPt ? [{ cx: robotPt.cx, cy: robotPt.cy, nodeId: "", yaw: 0 }, ...planPts] : planPts;
   for (let i = 0; i < arPts.length - 1; i++) {
    const mx = (arPts[i].cx + arPts[i + 1].cx) / 2;
    const my = (arPts[i].cy + arPts[i + 1].cy) / 2;
    const ang = Math.atan2(arPts[i + 1].cy - arPts[i].cy, arPts[i + 1].cx - arPts[i].cx);
    const isActive = goalPt && arPts[i + 1].nodeId === goalPt.nodeId;
    ctx.globalAlpha = isActive ? 1 : 0.4;
    ctx.beginPath();
    const al = 8;
    ctx.moveTo(mx + al * Math.cos(ang), my + al * Math.sin(ang));
    ctx.lineTo(mx - al * Math.cos(ang - 0.45), my - al * Math.sin(ang - 0.45));
    ctx.lineTo(mx - al * Math.cos(ang + 0.45), my - al * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
   }
   ctx.globalAlpha = 1;
  }

  // ── 6. 경유지 번호 원 (전체 계획 경로, goal 및 final 제외) ──────────────
  planPts.forEach((pt, i) => {
   if (i === 0) return; // 첫 번째 노드 (출발 직후 첫 goal 포함)
   const isGoal  = goalPt && pt.nodeId === goalPt.nodeId;
   const isFinal = i === planPts.length - 1;
   if (isGoal || isFinal) return; // goal·final 은 별도로 그림
   const isVisited = !remainSet.has(pt.nodeId);
   const r = 7;
   ctx.globalAlpha = isVisited ? 0.2 : 0.65;
   ctx.beginPath(); ctx.arc(pt.cx, pt.cy, r + 2, 0, Math.PI * 2);
   ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fill();
   ctx.beginPath(); ctx.arc(pt.cx, pt.cy, r, 0, Math.PI * 2);
   ctx.fillStyle = color + "99"; ctx.fill();
   ctx.font = "bold 9px monospace"; ctx.fillStyle = "#fff";
   ctx.textAlign = "center"; ctx.textBaseline = "middle";
   ctx.fillText(String(i), pt.cx, pt.cy);
   ctx.globalAlpha = 1;
  });

  // ── 7. 최종 목적지 마커 ★ ─────────────────────────────────────────────
  if (!isSingle) {
   const r = 11;
   ctx.globalAlpha = 0.9;
   ctx.beginPath(); ctx.arc(finalPt.cx, finalPt.cy, r + 2, 0, Math.PI * 2);
   ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fill();
   ctx.beginPath(); ctx.arc(finalPt.cx, finalPt.cy, r, 0, Math.PI * 2);
   ctx.fillStyle = color; ctx.fill();
   ctx.font = "bold 10px monospace"; ctx.fillStyle = "#fff";
   ctx.textAlign = "center"; ctx.textBaseline = "middle";
   ctx.fillText("★", finalPt.cx, finalPt.cy);
   ctx.globalAlpha = 1;
   // 목적지 라벨
   ctx.font = "bold 11px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
   ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
   ctx.strokeText(`→ ${finalPt.nodeId}`, finalPt.cx, finalPt.cy - 17);
   ctx.fillStyle = color; ctx.fillText(`→ ${finalPt.nodeId}`, finalPt.cx, finalPt.cy - 17);
  }

  // ── 8. 현재 GOAL 강조 마커 ─ 동심원 + crosshair + yaw 화살표 ──────────
  if (goalPt) {
   const { cx: gcx, cy: gcy, nodeId: gId, yaw: gYaw } = goalPt;

   // 동심원 (targeting 효과)
   ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.15;
   ctx.beginPath(); ctx.arc(gcx, gcy, 24, 0, Math.PI * 2); ctx.stroke();
   ctx.globalAlpha = 0.3;
   ctx.beginPath(); ctx.arc(gcx, gcy, 17, 0, Math.PI * 2); ctx.stroke();
   ctx.lineWidth = 2; ctx.globalAlpha = 0.65;
   ctx.beginPath(); ctx.arc(gcx, gcy, 11, 0, Math.PI * 2); ctx.stroke();
   ctx.globalAlpha = 1;

   // 내부 채움
   ctx.beginPath(); ctx.arc(gcx, gcy, 9, 0, Math.PI * 2);
   ctx.fillStyle = color + "33"; ctx.fill();
   ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

   // crosshair
   const chLen = 20;
   ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.55;
   ctx.beginPath(); ctx.moveTo(gcx - chLen, gcy); ctx.lineTo(gcx + chLen, gcy); ctx.stroke();
   ctx.beginPath(); ctx.moveTo(gcx, gcy - chLen); ctx.lineTo(gcx, gcy + chLen); ctx.stroke();
   ctx.globalAlpha = 1;

   // goal yaw 방향 화살표 + 화살촉
   const arLen = 26;
   const arX = gcx + Math.cos(-gYaw) * arLen;
   const arY = gcy + Math.sin(-gYaw) * arLen;
   ctx.beginPath(); ctx.moveTo(gcx, gcy); ctx.lineTo(arX, arY);
   ctx.strokeStyle = color; ctx.lineWidth = 2.5;
   ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
   const arAng = Math.atan2(arY - gcy, arX - gcx);
   const ah = 9;
   ctx.beginPath();
   ctx.moveTo(arX, arY);
   ctx.lineTo(arX - ah * Math.cos(arAng - 0.4), arY - ah * Math.sin(arAng - 0.4));
   ctx.lineTo(arX - ah * Math.cos(arAng + 0.4), arY - ah * Math.sin(arAng + 0.4));
   ctx.closePath(); ctx.fillStyle = color; ctx.fill();

   // GOAL 라벨
   ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.font = "bold 10px monospace";
   ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.9)";
   ctx.strokeText(`◎ ${gId}`, gcx, gcy - 28);
   ctx.fillStyle = color; ctx.fillText(`◎ ${gId}`, gcx, gcy - 28);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
 }

 // ── 로봇 마커 (amcl_pose, 현재 맵 배정 로봇만) ───────────────────────
 for (const robot of TB3_ROBOTS) {
 const robotAssignedMap2 = assignmentsRef.current[robot.id];
 if (robotAssignedMap2 && robotAssignedMap2 !== selectedMapRef.current) continue;
 const amcl = rosMessages[`/${robot.id}/amcl_pose`]?.data as {
 pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } }
 } | undefined;
 const pos = amcl?.pose?.pose?.position;
 const ori = amcl?.pose?.pose?.orientation;
 if (pos?.x == null) continue;

 const { cx, cy } = worldToCanvas(pos.x, pos.y ?? 0, info, scale);
 // 현재 맵 범위 밖 좌표는 다른 맵의 AMCL이므로 렌더 스킵
 const pad = 30;
 if (cx < -pad || cy < -pad || cx > canvas.width + pad || cy > canvas.height + pad) continue;
 const yaw = ori ? quatToYaw({ x: ori.x ?? 0, y: ori.y ?? 0, z: ori.z ?? 0, w: ori.w ?? 1 }) : 0;
 drawRobotMarker(ctx, cx, cy, yaw, robot.color, robot.label, selectedBots.has(robot.id));
 }

 // ── 드래그 중 프리뷰 ─────────────────────────────────────────────────
 if (dragRef.current) {
 const { sx, sy, cx, cy, type } = dragRef.current;
 const dx = cx - sx, dy = cy - sy;
 const yaw = (Math.abs(dx) + Math.abs(dy)) > 5 ? Math.atan2(dy, dx) : 0;
 const previewColor = type === "home" ? "#4ade80" : "#22d3ee";
 drawPreviewMarker(ctx, sx, sy, yaw, previewColor, "pose");
 }
 }, [rosMessages, selectedBots, showTopology, hoveredNodeId]);

 useEffect(() => { drawRef.current = draw; }, [draw]);
 useEffect(() => { draw(); }, [draw, canvasReady]);

 useEffect(() => {
 const obs = new ResizeObserver(() => draw());
 if (wrapRef.current) obs.observe(wrapRef.current);
 return () => obs.disconnect();
 }, [draw]);

 // ── 마우스 이벤트 ─────────────────────────────────────────────────────────

 const canvasXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
 const r = canvasRef.current!.getBoundingClientRect();
 return { x: e.clientX - r.left, y: e.clientY - r.top };
 };

 const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
 const { x, y } = canvasXY(e);
 const info = infoRef.current;
 const scale = scaleRef.current;

 // 좌클릭 시 노드 클릭 우선 처리
 if (e.button === 0 && showTopology && onNodeClickRef.current && info) {
 for (const n of topoNodesRef.current) {
 const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
 if (Math.hypot(x - cx, y - cy) <= 12) {
 onNodeClickRef.current(n.node_id);
 return;
 }
 }
 }

 if (!interactive) return;
 e.preventDefault();
 const type = e.button === 2 ? "pose" : homeMode ? "home" : null;
 if (!type) return;
 dragRef.current = { sx: x, sy: y, cx: x, cy: y, type };
 };

 const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
 const { x, y } = canvasXY(e);
 const info = infoRef.current;
 const scale = scaleRef.current;

 // hover 감지
 if (showTopology && info) {
 let foundNode = false;
 for (const n of topoNodesRef.current) {
 const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
 if (Math.hypot(x - cx, y - cy) <= 12) {
 if (hoveredNodeId !== n.node_id) setHoveredNodeId(n.node_id);
 if (hoveredEdgeId) setHoveredEdgeId(null);
 if (dragRef.current) { dragRef.current = { ...dragRef.current, cx: x, cy: y }; draw(); }
 foundNode = true;
 return;
 }
 }
 
 if (!foundNode) {
 if (hoveredNodeId) setHoveredNodeId(null);
 
 let foundEdge = false;
 for (const edge of topoEdgesRef.current) {
 const sn = topoNodesRef.current.find(n => n.node_id === edge.startNode);
 const en = topoNodesRef.current.find(n => n.node_id === edge.endNode);
 if (!sn || !en) continue;
 
 const { cx: sx, cy: sy } = worldToCanvas(sn.x, sn.y, info, scale);
 const { cx: ex, cy: ey } = worldToCanvas(en.x, en.y, info, scale);
 
 if (distToSegment(x, y, sx, sy, ex, ey) <= 6) {
 if (hoveredEdgeId !== edge.edge_id) setHoveredEdgeId(edge.edge_id);
 foundEdge = true;
 return;
 }
 }
 if (!foundEdge && hoveredEdgeId) setHoveredEdgeId(null);
 }
 } else {
 if (hoveredNodeId) setHoveredNodeId(null);
 if (hoveredEdgeId) setHoveredEdgeId(null);
 }

 if (!dragRef.current) return;
 dragRef.current = { ...dragRef.current, cx: x, cy: y };
 draw();
 };

 const onMouseUp = () => {
 if (!dragRef.current || !infoRef.current) return;
 const { sx, sy, cx, cy, type } = dragRef.current;
 dragRef.current = null;

 const info = infoRef.current;
 const scale = scaleRef.current;
 const dx = cx - sx, dy = cy - sy;
 const isClick = Math.abs(dx) < 5 && Math.abs(dy) < 5;
 
 let wx: number, wy: number, yaw: number;
 const hNode = hoveredNodeId ? topoNodesRef.current.find(n => n.node_id === hoveredNodeId) : null;

 if (hNode && isClick) {
 wx = hNode.x;
 wy = hNode.y;
 yaw = hNode.yaw;
 } else {
 const wPos = canvasToWorld(sx, sy, info, scale);
 wx = wPos.wx;
 wy = wPos.wy;
 yaw = isClick ? 0 : Math.atan2(-dy, dx);
 }

 for (const id of selectedBots) {
 if (type === "home") onSetHome?.(id, wx, wy, yaw);
 else onSetInitialPose(id, wx, wy, yaw, selectedMap || undefined);
 }
 draw();
 };

 const onMouseLeave = () => {
 dragRef.current = null;
 if (hoveredNodeId) setHoveredNodeId(null);
 draw();
 };
 const onContextMenu = (e: React.MouseEvent) => e.preventDefault();

 const cameraBot = TB3_ROBOTS.find((r) => selectedBots.has(r.id))?.id ?? "tb3_01";
 const cameraRobotMeta = TB3_ROBOTS.find((r) => r.id === cameraBot);
 const soloBot = selectedBots.size === 1 ? [...selectedBots][0] : null;
 const selectedPlanPoses = soloBot
 ? (rosMessages[`/${soloBot}/plan`]?.data as { poses?: unknown[] } | undefined)?.poses
 : undefined;

 // hover 중인 노드/엣지 정보
 const hNode = hoveredNodeId ? topoNodesRef.current.find(n => n.node_id === hoveredNodeId) : null;
 const hEdge = hoveredEdgeId && !hNode ? topoEdgesRef.current.find(e => e.edge_id === hoveredEdgeId) : null;

 return (
 <div className="flex flex-col h-full bg-[#FFCE99]/14 backdrop-blur-xl">

 {/* ── 툴바 ──────────────────────────────────────────────────────────── */}
 <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-[#521C0D]/10 bg-[#FFCE99]/32 flex-wrap">

 {/* 맵 선택 */}
 <div className="flex items-center gap-1.5">
 <span className="text-xs text-white/[0.6] tracking-wide">MAP</span>
 <select
 value={selectedMap}
 onChange={async (e) => {
 const mapName = e.target.value;
 setSelectedMap(mapName);
 if (!mapName || selectedBots.size === 0) return;
 setAssignLoading(true);
 try {
 await Promise.all([...selectedBots].map((robotId) =>
 fetch(`${base}/api/map/assign`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ robotId, mapName }),
 }).then((r) => r.json())
 ));
 setAssignments((prev) => {
 const next = { ...prev };
 for (const id of selectedBots) next[id] = mapName;
 return next;
 });
 } finally {
 setAssignLoading(false);
 }
 }}
 className={`text-xs bg-[#FFCE99]/32 border text-white/90 px-2 py-0.5 max-w-[160px] truncate ${
 assignLoading ? "border-white/[0.1] text-white/90" : "border-white/[0.1]"
 }`}
 >
 {availableMaps.length === 0 && <option value="">맵 없음</option>}
 {availableMaps.map((m) => <option key={m} value={m}>{m}</option>)}
 </select>
 {assignLoading && (
 <span className="text-xs text-white/90/70 animate-pulse">로딩...</span>
 )}
 </div>

 <div className="w-px h-4 bg-[#FFCE99]/32" />

 {/* 로봇 선택 */}
 <div className="flex items-center gap-1.5">
 <span className="text-xs text-white/[0.6] tracking-wide">ROBOT</span>
 <div className="flex">
 <button
 onClick={() => {
 const allIds = TB3_ROBOTS.map((r) => r.id);
 const allSelected = allIds.every((id) => selectedBots.has(id));
 setSelectedBots(allSelected ? new Set() : new Set(allIds));
 }}
 className={`px-2 py-0.5 text-xs font-bold border-r border-white/[0.1] transition-all ${
 TB3_ROBOTS.every((r) => selectedBots.has(r.id))
 ? "bg-[#521C0D] text-[#F4E7E1]"
 : "text-white/[0.68] hover:text-white/90"
 }`}
 >
 ALL
 </button>
 {TB3_ROBOTS.map((r) => {
 const isOn = selectedBots.has(r.id);
 const hasPos = rosMessages[`/${r.id}/amcl_pose`]?.data != null;
 const hasPlan = ((rosMessages[`/${r.id}/plan`]?.data as { poses?: unknown[] } | undefined)?.poses?.length ?? 0) > 0;
 return (
 <button
 key={r.id}
 onClick={() => {
 setSelectedBots((prev) => {
 const next = new Set(prev);
 if (next.has(r.id)) next.delete(r.id);
 else next.add(r.id);
 return next;
 });
 }}
 className="relative px-2 py-0.5 text-xs font-bold border-r border-white/[0.1] last:border-0 transition-all"
 style={isOn
 ? { background: r.color, color: "#000" }
 : { color: hasPos ? r.color + "66" : "#2a2a2a" }}
 >
 {r.label}
 {hasPlan && (
 <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-400" />
 )}
 {assignments[r.id] && (
 <span
 className="absolute -bottom-3 left-0 right-0 text-center text-[7px] text-white/[0.68] truncate"
 title={assignments[r.id]}
 >
 {assignments[r.id].length > 6 ? assignments[r.id].slice(0, 6) + "…" : assignments[r.id]}
 </span>
 )}
 </button>
 );
 })}
 </div>
 </div>

 <div className="w-px h-4 bg-[#FFCE99]/32" />

 {/* 조작 토글 */}
 <button
 onClick={() => setInteractive((v) => !v)}
 className={`px-3 py-1 text-xs font-bold tracking-wider border transition-all ${
 interactive
 ? "border-white/[0.1] text-white/90 bg-blue-950/20"
 : "border-white/[0.1] text-white/[0.55] hover:text-white/[0.75]"
 }`}
 >
 {interactive ? "● 조작 중" : "○ 보기"}
 </button>

 {/* 홈 설정 */}
 {onSetHome && interactive && (
 <button
 onClick={() => setHomeMode((v) => !v)}
 className={`px-3 py-1 text-xs font-bold tracking-wider border transition-all ${
 homeMode
 ? "border-white/[0.1] text-white/90 bg-green-950/20"
 : "border-white/[0.1] text-white/[0.55] hover:text-white/[0.75]"
 }`}
 >
 {homeMode ? "● 홈 설정" : "⌂ 홈"}
 </button>
 )}

 {/* 토폴로지 토글 */}
 <button
 onClick={() => setShowTopology((v) => !v)}
 className={`px-3 py-1 text-xs font-bold tracking-wider border transition-all ${
 showTopology
 ? "border-white/[0.1] text-white/90 bg-amber-950/20"
 : "border-white/[0.1] text-white/[0.55] hover:text-white/[0.75]"
 }`}
 title={`노드 ${topoStats.n}개 / 엣지 ${topoStats.e}개`}
 >
 ⬡ 노드{topoStats.n > 0 ? ` ${topoStats.n}` : ""}
 </button>

 {/* 조작 힌트 */}
 {interactive && (
 <div className="flex items-center gap-3">
 <span className="flex items-center gap-1 text-xs ">
 <kbd className="px-1 py-0.5 border border-white/[0.1] text-white/[0.6] text-xs">L</kbd>
 <span className={homeMode ? "text-white/90/70" : "text-white/90/70"}>
 {homeMode ? "홈" : "목표"}
 </span>
 </span>
 <span className="flex items-center gap-1 text-xs ">
 <kbd className="px-1 py-0.5 border border-white/[0.1] text-white/[0.6] text-xs">R</kbd>
 <span className="text-white/90/70">초기위치</span>
 </span>
 </div>
 )}

 {showTopology && onNodeClick && (
 <span className="text-xs text-white/90/60">
 노드 클릭 → 태스크 목표 설정
 </span>
 )}

 {/* 카메라 토글 */}
 <button
 onClick={() => setShowCamera((v) => !v)}
 className={`ml-auto px-3 py-1 text-xs font-bold tracking-wider border transition-all ${
 showCamera
 ? "border-white/[0.1] text-white/90 bg-green-950/20"
 : "border-white/[0.1] text-white/[0.55] hover:text-white/[0.75]"
 }`}
 >
 ◉ CAM
 </button>
 </div>

 {/* ── 본문 ─────────────────────────────────────────────────────────── */}
 <div ref={wrapRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-[#FFCE99]/14 backdrop-blur-xl">

 {!canvasReady ? (
 <span className="text-xs text-white/[0.55] tracking-wide">
 {availableMaps.length === 0 ? "맵 파일 없음" : "맵 로딩 중…"}
 </span>
 ) : (
 <canvas
 ref={canvasRef}
 onMouseDown={onMouseDown}
 onMouseMove={onMouseMove}
 onMouseUp={onMouseUp}
 onMouseLeave={onMouseLeave}
 onContextMenu={onContextMenu}
 className={hoveredNodeId && onNodeClick ? "cursor-pointer" : interactive ? "cursor-crosshair" : "cursor-default"}
 style={{ imageRendering: "pixelated", display: "block" }}
 />
 )}

 {/* hover 노드 정보 */}
 {hNode && (
 <div className="absolute top-2 right-2 bg-[#FFCE99]/14 border border-white/[0.1] px-2 py-1.5 pointer-events-none">
 <div className="text-xs font-bold" style={{ color: NODE_COLOR[hNode.type] ?? "#888" }}>
 {hNode.node_id}
 </div>
 <div className="text-xs text-white/[0.75] mt-0.5">
 x={hNode.x.toFixed(3)} y={hNode.y.toFixed(3)}
 </div>
 <div className="text-xs text-white/[0.75]">
 yaw={hNode.yaw.toFixed(3)} <span style={{ color: NODE_COLOR[hNode.type] }}>{hNode.type}</span>
 </div>
 {onNodeClick && (
 <div className="text-xs text-white/90/70 mt-0.5">클릭하여 태스크 목표 선택</div>
 )}
 </div>
 )}

 {/* hover 엣지 정보 */}
 {hEdge && (
 <div className="absolute top-2 right-2 bg-[#FFCE99]/14 border border-white/[0.1] px-2 py-1.5 pointer-events-none z-10 shadow-lg">
 <div className="flex items-center gap-2 text-white/90">
 <span className="text-xs font-bold text-white/90">{hEdge.edge_id}</span>
 {hEdge.isLocked && <span className="text-xs text-white/90">🔒 잠김</span>}
 </div>
 <div className="text-xs text-white/[0.75] mt-0.5">
 {hEdge.startNode} {hEdge.direction === "BOTH_WAY" ? "↔" : "→"} {hEdge.endNode}
 </div>
 <div className="text-xs text-white/90/80">
 가중치: {hEdge.weight ?? 1}
 </div>
 </div>
 )}

 {/* 카메라 오버레이 */}
 {showCamera && socket && canvasReady && (
 <div className="absolute bottom-3 right-3 w-56 z-10 shadow-2xl shadow-black/80 border border-white/[0.1]">
 <div className="flex items-center justify-between px-2 py-1 bg-[#FFCE99]/32 border-b border-white/[0.1]">
 <span
 className="text-xs font-bold tracking-wide"
 style={{ color: cameraRobotMeta?.color ?? "#888" }}
 >
 ◉ {cameraRobotMeta?.label ?? cameraBot}{selectedBots.size > 1 && ` (+${selectedBots.size - 1})`}
 </span>
 <button onClick={() => setShowCamera(false)} className="text-xs text-white/[0.55] hover:text-white/[0.75]">✕</button>
 </div>
 <CameraFeed botId={cameraBot} label={cameraRobotMeta?.label ?? cameraBot} socket={socket} />
 </div>
 )}

 {/* 범례 (좌상단) */}
 {canvasReady && (
 <div className="absolute top-2 left-2 flex flex-col gap-1 bg-[#FFCE99]/14 backdrop-blur-xl/90 px-2 py-1.5 border border-[#521C0D]/10">
 {TB3_ROBOTS.map((r) => {
 const isOn = selectedBots.has(r.id);
 const hasPos = rosMessages[`/${r.id}/amcl_pose`]?.data != null;
 const hasPlan = ((rosMessages[`/${r.id}/plan`]?.data as { poses?: unknown[] } | undefined)?.poses?.length ?? 0) > 0;
 return (
 <button
 key={r.id}
 onClick={() => setSelectedBots((prev) => {
 const next = new Set(prev);
 if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
 return next;
 })}
 className={`flex items-center gap-1.5 text-left transition-all ${isOn ? "opacity-100" : "opacity-40 hover:opacity-70"}`}
 >
 <span className="w-2 h-2 rounded-full flex-none" style={{ background: r.color, opacity: hasPos ? 1 : 0.2 }} />
 <span className={`text-xs ${hasPos ? "text-white/[0.75]" : "text-white/[0.55]"}`}>{r.label}</span>
 {hasPlan && <span className="text-[6px]" style={{ color: r.color }}>▶ 경로</span>}
 </button>
 );
 })}
 {/* 토폴로지 범례 */}
 {showTopology && topoStats.n > 0 && (
 <>
 <div className="h-px bg-[#FFCE99]/32 my-0.5" />
 {(["WAYPOINT","STATION","CHARGER"] as const).map(t => (
 <div key={t} className="flex items-center gap-1.5">
 <div className="w-2 h-2 rounded-full flex-none" style={{ background: NODE_COLOR[t] }} />
 <span className="text-[7px] text-white/[0.6]">{t}</span>
 </div>
 ))}
 <div className="text-[7px] text-white/[0.55]">E:{topoStats.e}</div>
 </>
 )}
 </div>
 )}
 </div>

 {/* ── 하단 정보 바 ─────────────────────────────────────────────────── */}
 {mapInfo && (
 <div className="flex-none flex gap-4 px-3 py-1 border-t border-[#521C0D]/10 bg-[#FFCE99]/14 text-xs text-white/[0.55]">
 <span className="text-white/[0.55]">{selectedMap}</span>
 <span>{mapInfo.width}×{mapInfo.height}px</span>
 <span>{mapInfo.resolution}m/px</span>
 <span>원점 ({mapInfo.originX.toFixed(2)}, {mapInfo.originY.toFixed(2)})</span>
 {topoStats.n > 0 && (
 <span className="text-amber-700">N:{topoStats.n} E:{topoStats.e}</span>
 )}
 {(selectedPlanPoses?.length ?? 0) > 0 && (
 <span style={{ color: cameraRobotMeta?.color }}>▶ 경로 {selectedPlanPoses!.length}pt</span>
 )}
 </div>
 )}
 </div>
 );
}

// ── 드로잉 헬퍼 ───────────────────────────────────────────────────────────────

function drawRobotMarker(
 ctx: CanvasRenderingContext2D,
 cx: number, cy: number, yaw: number,
 color: string, label: string, selected: boolean,
) {
 const r = selected ? 9 : 6;
 ctx.save();
 ctx.translate(cx, cy);

 if (selected) {
 ctx.beginPath();
 ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
 ctx.strokeStyle = color + "44";
 ctx.lineWidth = 3;
 ctx.stroke();
 }

 ctx.beginPath();
 ctx.arc(0, 0, r, 0, Math.PI * 2);
 ctx.fillStyle = color + (selected ? "cc" : "88");
 ctx.fill();
 ctx.strokeStyle = color;
 ctx.lineWidth = selected ? 2.5 : 1.5;
 ctx.stroke();

 const len = r + 10;
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(Math.cos(-yaw) * len, Math.sin(-yaw) * len);
 ctx.strokeStyle = color;
 ctx.lineWidth = selected ? 2.5 : 1.5;
 ctx.stroke();

 ctx.fillStyle = color;
 ctx.font = `bold ${selected ? 10 : 8}px monospace`;
 ctx.textAlign = "center";
 ctx.fillText(label, 0, -r - 5);

 ctx.restore();
}

function drawPreviewMarker(
 ctx: CanvasRenderingContext2D,
 cx: number, cy: number, yaw: number,
 color: string, type: "goal" | "pose",
) {
 ctx.save();
 ctx.translate(cx, cy);

 ctx.beginPath();
 ctx.arc(0, 0, 9, 0, Math.PI * 2);
 ctx.fillStyle = color + "33";
 ctx.fill();
 ctx.strokeStyle = color;
 ctx.lineWidth = 2;
 ctx.setLineDash([3, 2]);
 ctx.stroke();
 ctx.setLineDash([]);

 const len = 24;
 const hx = Math.cos(yaw) * len;
 const hy = Math.sin(yaw) * len;
 ctx.beginPath();
 ctx.moveTo(0, 0);
 ctx.lineTo(hx, hy);
 ctx.strokeStyle = color;
 ctx.lineWidth = 2.5;
 ctx.stroke();

 const a = Math.atan2(hy, hx);
 ctx.beginPath();
 ctx.moveTo(hx, hy);
 ctx.lineTo(hx - 9 * Math.cos(a - 0.4), hy - 9 * Math.sin(a - 0.4));
 ctx.lineTo(hx - 9 * Math.cos(a + 0.4), hy - 9 * Math.sin(a + 0.4));
 ctx.closePath();
 ctx.fillStyle = color;
 ctx.fill();

 ctx.fillStyle = color;
 ctx.font = "bold 9px monospace";
 ctx.textAlign = "center";
 ctx.fillText(type === "goal" ? "GOAL" : "INIT", 0, -15);

 ctx.restore();
}
