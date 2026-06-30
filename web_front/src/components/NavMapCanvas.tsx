import { useEffect, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, type RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import CameraFeed from "./cameras/CameraFeed";
import { snapNodes } from "./TopologyMapView";
import type { FNode, FEdge, ActivePath, RobotPos } from "./TopologyMapView";
import type { StaticMapInfo, DragState } from "./navmap/types";
import { TB3_ROBOTS, SELECTABLE_ROBOTS, NODE_COLOR } from "./navmap/constants";
import { worldToCanvas, canvasToWorld, distToSegment } from "./navmap/geometry";
import { drawPreviewMarker } from "./navmap/markers";
import { drawPlanPaths, drawTopologyOverlay, drawActivePaths, drawTb3Markers, buildActivePathColors } from "./navmap/renderers";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
 rosMessages: Record<string, RosMessage>;
 socket: Socket | null;
 onSetInitialPose: (robotId: string, x: number, y: number, yaw: number, mapId?: string) => void;
 onSetHome?: (robotId: string, x: number, y: number, yaw: number) => void;
 activePaths?: ActivePath[];
 robotPositions?: Record<string, RobotPos>;
 robots?: RobotInfo[]; // 로봇별 location(맵) — 마커를 robot.location 기준으로 필터(단일 출처)
 onNodeClick?: (nodeId: string) => void;
 /** 선택된 노드 정보 패널에서 잠금/해제 토글 (소켓 node_lock → 우회 재경로 트리거) */
 onNodeLockToggle?: (nodeId: string) => void;
 lockedNodes?: Set<string>;
 /** 할당 전 미리보기 경로 (노드 ID 순서) — 점선으로 표시 */
 previewPath?: string[];
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function NavMapCanvas({
 rosMessages, socket, onSetInitialPose, onSetHome,
 activePaths = [], robotPositions = {}, robots = [], onNodeClick, onNodeLockToggle, lockedNodes = new Set(), previewPath = [],
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
 const onNodeLockToggleRef = useRef(onNodeLockToggle);
 const lockedNodesRef = useRef<Set<string>>(lockedNodes);
 const previewPathRef = useRef<string[]>(previewPath);
 const lastVictimTs = useRef(0); // /victim/confirmed 중복 처리 방지
 // 마커·경로·자동선택 필터 기준 — robot.location(단일 출처). assignments(수동 맵 배정)와 별개.
 const robotLocationsRef = useRef<Record<string, string>>({});
 const selectedMapRef = useRef<string>("");
 const drawRef = useRef<() => void>(() => {});

 const [availableMaps, setAvailableMaps] = useState<string[]>([]);
 const [selectedMap, setSelectedMap] = useState<string>("");
 const [assignments, setAssignments] = useState<Record<string, string>>({});
 const [assignLoading, setAssignLoading] = useState(false);
 const [mapInfo, setMapInfo] = useState<StaticMapInfo | null>(null);
 const [canvasReady, setCanvasReady] = useState(false);
 const [interactive, setInteractive] = useState(true);
 const [homeMode] = useState(false);
 const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set()); // 기본 선택 없음(tb3_01 자동 활성화 해제)
 const [showCamera, setShowCamera] = useState(true);
 const [showTopology, setShowTopology] = useState(true);
 const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
 const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
 const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
 const [topoStats, setTopoStats] = useState({ n: 0, e: 0 });
 const [nodeRefresh, setNodeRefresh] = useState(0); // /victim/confirmed 시 토폴로지 재조회 트리거

 const base = BACKEND_URL.replace(/\/$/, "");

 // 홈: 선택된 로봇들을 맵의 초기위치 노드(initPosition=true)로 초기위치 지정
 const resetToMapHome = useCallback(async () => {
 if (!selectedMap || selectedBots.size === 0) return;
 try {
 const nodes = await fetch(`${base}/api/fleet/topology/nodes?map_id=${selectedMap}`).then((r) => r.json());
 const init = Array.isArray(nodes) ? nodes.find((n: { initPosition?: boolean }) => n.initPosition) : null;
 if (!init) { console.warn(`[홈] 맵 "${selectedMap}"에 초기위치 노드(initPosition) 없음`); return; }
 for (const robotId of selectedBots) {
 onSetInitialPose(robotId, init.x, init.y, init.yaw ?? 0, selectedMap);
 }
 } catch (e) { console.error("[홈] 초기위치 지정 실패", e); }
 }, [base, selectedMap, selectedBots, onSetInitialPose]);

 // keep refs in sync
 useEffect(() => { activePathsRef.current = activePaths; drawRef.current(); }, [activePaths]);
 useEffect(() => { robotPosRef.current = robotPositions; }, [robotPositions]);
 useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);
 useEffect(() => { onNodeLockToggleRef.current = onNodeLockToggle; }, [onNodeLockToggle]);
 useEffect(() => { previewPathRef.current = previewPath; drawRef.current(); }, [previewPath]);
 // /victim/confirmed 새로 수신 시 토폴로지 재조회(백엔드가 VICTIM 노드 생성) — 살짝 지연 후
 useEffect(() => {
 const ts = rosMessages["/victim/confirmed"]?.timestamp;
 if (!ts || ts === lastVictimTs.current) return;
 lastVictimTs.current = ts;
 const id = setTimeout(() => setNodeRefresh((n) => n + 1), 700);
 return () => clearTimeout(id);
 }, [rosMessages]);
 useEffect(() => { lockedNodesRef.current = lockedNodes; drawRef.current(); }, [lockedNodes]);
 useEffect(() => { robotLocationsRef.current = Object.fromEntries(robots.filter((r) => r.location).map((r) => [r.robot_id, r.location as string])); }, [robots]);
 useEffect(() => { selectedMapRef.current = selectedMap; }, [selectedMap]);

 // ── 맵 목록 + 할당 로드 ──────────────────────────────────────────────────

 useEffect(() => {
 let alive = true;
 // 정적 맵 목록 1회 조회 (비어 있으면 반영 안 함 — 백엔드 재시작 중 빈 지도 방지).
 // 자동 맵 선택 안 함(맵 선택 해제) — 사용자가 로봇을 선택하면 그 로봇 맵(robot.location)으로 전환된다.
 const fetchList = async (): Promise<boolean> => {
 try {
 const [lr, ar] = await Promise.all([
 fetch(`${base}/api/map/static/list`),
 fetch(`${base}/api/map/assignments`),
 ]);
 if (lr.ok && ar.ok) {
 const list = (await lr.json()) as string[];
 const asgn = (await ar.json()) as Record<string, string>;
 if (alive && Array.isArray(list) && list.length) { setAvailableMaps(list); setAssignments(asgn); return true; }
 }
 } catch { /* 재시도 */ }
 return false;
 };
 // 첫 로딩 재시도(채워질 때까지)
 const load = async (tries = 10) => {
 for (let i = 0; i < tries && alive; i++) {
 if (await fetchList()) return;
 await new Promise((res) => setTimeout(res, 1200));
 }
 };
 void load();
 // 새로 저장된 정적 맵(정찰 탭 "Fleet에 저장")이 목록에 반영되도록 주기 갱신(선택 상태 유지)
 const poll = setInterval(() => { void fetchList(); }, 15000);
 return () => { alive = false; clearInterval(poll); };
 }, [base]);

 // ── 맵이 주(主), 터틀봇은 종속 ──────────────────────────────────────────────
 // 맵은 사용자가 드롭다운으로 직접 선택하고(이게 단일 기준), 로봇 마커는 draw에서
 // robot.location === 선택 맵 인 로봇만 그린다. 로봇을 선택해도 맵을 바꾸지 않는다.
 // (이전: 선택 로봇의 location 으로 맵을 강제 전환 → robots 텔레메트리 갱신마다 재실행되어
 //  수동 맵 선택이 로봇 위치로 되돌아가는 버그가 있었음. 제거함.)

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

 // 토폴로지 변경(예: /victim/confirmed로 VICTIM 노드 생성) 시 노드/엣지만 가볍게 재조회 (이미지 재로딩 없음)
 useEffect(() => {
 if (nodeRefresh === 0 || !selectedMap) return;
 const snap = infoRef.current?.snapThreshold ?? 0.25;
 Promise.all([
 fetch(`${base}/api/fleet/topology/nodes?map_id=${selectedMap}`).then((r) => r.json()).catch(() => []),
 fetch(`${base}/api/fleet/topology/edges`).then((r) => r.json()).catch(() => []),
 ]).then(([ns, es]) => {
 const nodes = Array.isArray(ns) ? (ns as FNode[]) : [];
 const snappedNodes = snapNodes(nodes, snap);
 const nodeIds = new Set(snappedNodes.map((n) => n.node_id));
 const allEdges = Array.isArray(es) ? (es as FEdge[]) : [];
 const edges = allEdges.filter((e) => nodeIds.has(e.startNode) && nodeIds.has(e.endNode));
 topoNodesRef.current = snappedNodes;
 topoEdgesRef.current = edges;
 setTopoStats({ n: snappedNodes.length, e: edges.length });
 drawRef.current();
 });
 }, [nodeRefresh, selectedMap, base]);

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

 const robotMaps = robotLocationsRef.current; // 마커·경로·자동선택 모두 robot.location 기준(단일 출처)
 const selectedMap = selectedMapRef.current;

 // TB3 계획 경로(/plan)
 drawPlanPaths(ctx, info, scale, rosMessages, robotMaps, selectedMap, selectedBots);

 // 활성 경로 필터 + 로봇별 색 (토폴로지·경로 오버레이가 공유)
 const { filteredApaths, robotColorMap } = buildActivePathColors(
 activePathsRef.current, robotMaps, selectedMap,
 );

 // 토폴로지 오버레이 (노드/엣지 + 비-TB3 로봇)
 if (showTopology) {
 drawTopologyOverlay(ctx, canvas, info, scale, {
 topoNodes: topoNodesRef.current,
 topoEdges: topoEdgesRef.current,
 robPos: robotPosRef.current,
 filteredApaths,
 robotColorMap,
 hoveredNodeId,
 lockedSet: lockedNodesRef.current,
 rosMessages,
 robotMaps,
 selectedMap,
 });
 }

 // 활성 경로 오버레이 (전체 경로 + 현재 goal)
 drawActivePaths(ctx, info, scale, {
 filteredApaths,
 robotColorMap,
 rosMessages,
 topoNodes: topoNodesRef.current,
 });

 // 할당 전 경로 미리보기 (노란 점선)
 const preview = previewPathRef.current;
 if (showTopology && preview.length > 1) {
 const pts = preview
 .map(id => topoNodesRef.current.find(n => n.node_id === id))
 .filter((n): n is FNode => !!n)
 .map(n => worldToCanvas(n.x, n.y, info, scale));
 if (pts.length > 1) {
 ctx.save();
 ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 3; ctx.setLineDash([9, 6]);
 ctx.beginPath(); ctx.moveTo(pts[0].cx, pts[0].cy);
 for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].cx, pts[i].cy);
 ctx.stroke(); ctx.setLineDash([]);
 for (const p of pts) { ctx.beginPath(); ctx.arc(p.cx, p.cy, 5, 0, Math.PI * 2); ctx.fillStyle = "#fbbf24"; ctx.fill(); }
 ctx.restore();
 }
 }

 // TB3 로봇 마커 (amcl_pose, robot.location 이 현재 맵인 로봇만)
 drawTb3Markers(ctx, canvas, info, scale, rosMessages, robotMaps, selectedMap, selectedBots);

 // 드래그 중 프리뷰
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

 // 좌클릭 시 노드 선택(정보 패널) + 태스크 목표 지정
 if (e.button === 0 && showTopology && info) {
 for (const n of topoNodesRef.current) {
 const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
 if (Math.hypot(x - cx, y - cy) <= 12) {
 setSelectedNodeId(n.node_id);
 onNodeClickRef.current?.(n.node_id);
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
 // 우클릭은 위치추정(pose)/홈 지정 전용 — 기본 컨텍스트 메뉴만 막는다
 const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => e.preventDefault();

 const cameraBot = TB3_ROBOTS.find((r) => selectedBots.has(r.id))?.id ?? null; // 선택 로봇 없으면 null → 카메라 닫음(폴백 제거)
 const cameraRobotMeta = TB3_ROBOTS.find((r) => r.id === cameraBot);
 const soloBot = selectedBots.size === 1 ? [...selectedBots][0] : null;
 const selectedPlanPoses = soloBot
 ? (rosMessages[`/${soloBot}/plan`]?.data as { poses?: unknown[] } | undefined)?.poses
 : undefined;

 // hover 중인 노드/엣지 정보
 const hNode = hoveredNodeId ? topoNodesRef.current.find(n => n.node_id === hoveredNodeId) : null;
 const hEdge = hoveredEdgeId && !hNode ? topoEdgesRef.current.find(e => e.edge_id === hoveredEdgeId) : null;
 // 좌클릭으로 선택된 노드 (정보 패널 + 잠금/해제 버튼)
 const selNode = selectedNodeId ? topoNodesRef.current.find(n => n.node_id === selectedNodeId) : null;

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
 <option value="">{availableMaps.length === 0 ? "맵 없음" : "맵 선택"}</option>
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
 const allIds = SELECTABLE_ROBOTS.map((r) => r.id);
 const allSelected = allIds.every((id) => selectedBots.has(id));
 setSelectedBots(allSelected ? new Set() : new Set(allIds));
 }}
 className={`px-2 py-0.5 text-xs font-bold border-r border-white/[0.1] transition-all ${
 SELECTABLE_ROBOTS.every((r) => selectedBots.has(r.id))
 ? "bg-[#521C0D] text-[#F4E7E1]"
 : "text-white/[0.68] hover:text-white/90"
 }`}
 >
 ALL
 </button>
 {SELECTABLE_ROBOTS.map((r) => {
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

 {/* 홈 — 선택 로봇을 맵 초기위치 노드로 이동(원클릭) */}
 {interactive && (
 <button
 onClick={resetToMapHome}
 title="선택된 로봇들을 맵의 초기위치로 이동"
 className="px-3 py-1 text-xs font-bold tracking-wider border border-white/[0.1] text-white/[0.55] hover:text-white/90 transition-all"
 >
 ⌂ 홈
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

 {/* 조작 힌트 (L 목표 제거됨) */}
 {interactive && (
 <div className="flex items-center gap-3">
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

 {/* 선택된 노드 정보 + 잠금/해제 (좌클릭으로 선택) */}
 {selNode && (
 <div className="absolute top-2 right-2 bg-[#FFCE99]/14 border border-white/[0.1] px-3 py-2 shadow-lg z-20 min-w-[150px]">
 <div className="flex items-center justify-between gap-3">
 <span className="text-xs font-bold" style={{ color: NODE_COLOR[selNode.type] ?? "#888" }}>{selNode.node_id}</span>
 <button onClick={() => setSelectedNodeId(null)} className="text-white/[0.45] hover:text-white/80 text-sm leading-none">✕</button>
 </div>
 <div className="text-xs text-white/[0.75] mt-1">x={selNode.x.toFixed(3)} y={selNode.y.toFixed(3)}</div>
 <div className="text-xs text-white/[0.75]">yaw={selNode.yaw.toFixed(3)} <span style={{ color: NODE_COLOR[selNode.type] }}>{selNode.type}</span></div>
 {lockedNodes.has(selNode.node_id) && (
 <div className="text-xs font-bold text-red-400 mt-1">🔒 잠김 (경로 우회)</div>
 )}
 {onNodeLockToggle && (
 <button
 onClick={() => onNodeLockToggle(selNode.node_id)}
 className={`mt-2 w-full text-xs font-bold py-1.5 rounded border transition-colors ${
 lockedNodes.has(selNode.node_id)
 ? "bg-emerald-700/40 text-emerald-200 border-emerald-500/40 hover:bg-emerald-600/50"
 : "bg-red-900/40 text-red-200 border-red-500/40 hover:bg-red-800/50"
 }`}>
 {lockedNodes.has(selNode.node_id) ? "🔓 잠금 해제" : "🔒 노드 잠금 (우회)"}
 </button>
 )}
 </div>
 )}

 {/* hover 노드 정보 (노드 미선택 시에만 표시) */}
 {hNode && !selNode && (
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
 <div className="text-xs text-white/90/70 mt-0.5">클릭하여 선택 · 태스크 목표 지정</div>
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

 {/* 카메라 오버레이 — 선택 로봇(cameraBot) 있을 때만 */}
 {showCamera && socket && canvasReady && cameraBot && (
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
 {SELECTABLE_ROBOTS.map((r) => {
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
