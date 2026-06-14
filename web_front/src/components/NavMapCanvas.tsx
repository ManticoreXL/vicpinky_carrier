import { useEffect, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import CameraFeed from "./CameraFeed";
import type { FNode, FEdge, ActivePath, RobotPos } from "./TopologyMapView";

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface StaticMapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

const TB3_ROBOTS = [
  { id: "tb3_01", label: "TB3-01", color: "#3b82f6" },
  { id: "tb3_02", label: "TB3-02", color: "#10b981" },
  { id: "tb3_03", label: "TB3-03", color: "#f59e0b" },
  { id: "tb3_04", label: "TB3-04", color: "#8b5cf6" },
] as const;

const NODE_COLOR: Record<string, string> = {
  WAYPOINT: "#60a5fa",
  STATION:  "#fbbf24",
  CHARGER:  "#4ade80",
};

const ROBOT_COLORS = ["#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#38bdf8"];

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

function quatToYaw(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages:      Record<string, RosMessage>;
  socket:           Socket | null;
  onSendGoal:       (robotId: string, x: number, y: number, yaw: number) => void;
  onSetInitialPose: (robotId: string, x: number, y: number, yaw: number) => void;
  onSetHome?:       (robotId: string, x: number, y: number, yaw: number) => void;
  activePaths?:     ActivePath[];
  robotPositions?:  Record<string, RobotPos>;
  onNodeClick?:     (nodeId: string) => void;
}

interface DragState {
  sx: number; sy: number;
  cx: number; cy: number;
  type: "goal" | "pose" | "home";
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function NavMapCanvas({
  rosMessages, socket, onSendGoal, onSetInitialPose, onSetHome,
  activePaths = [], robotPositions = {}, onNodeClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const infoRef   = useRef<StaticMapInfo | null>(null);
  const scaleRef  = useRef(1);
  const dragRef   = useRef<DragState | null>(null);

  // topology refs — don't add to draw deps
  const topoNodesRef    = useRef<FNode[]>([]);
  const topoEdgesRef    = useRef<FEdge[]>([]);
  const activePathsRef  = useRef<ActivePath[]>(activePaths);
  const robotPosRef     = useRef<Record<string, RobotPos>>(robotPositions);
  const onNodeClickRef  = useRef(onNodeClick);
  const drawRef         = useRef<() => void>(() => {});

  const [availableMaps,   setAvailableMaps]   = useState<string[]>([]);
  const [selectedMap,     setSelectedMap]     = useState<string>("");
  const [assignments,     setAssignments]     = useState<Record<string, string>>({});
  const [assignLoading,   setAssignLoading]   = useState(false);
  const [mapInfo,         setMapInfo]         = useState<StaticMapInfo | null>(null);
  const [canvasReady,     setCanvasReady]     = useState(false);
  const [interactive,     setInteractive]     = useState(true);
  const [homeMode,        setHomeMode]        = useState(false);
  const [selectedBots,    setSelectedBots]    = useState<Set<string>>(new Set(["tb3_01"]));
  const [showCamera,      setShowCamera]      = useState(true);
  const [showTopology,    setShowTopology]    = useState(true);
  const [hoveredNodeId,   setHoveredNodeId]   = useState<string | null>(null);
  const [topoStats,       setTopoStats]       = useState({ n: 0, e: 0 });

  const base = BACKEND_URL.replace(/\/$/, "");

  // keep refs in sync
  useEffect(() => { activePathsRef.current = activePaths; drawRef.current(); }, [activePaths]);
  useEffect(() => { robotPosRef.current = robotPositions; }, [robotPositions]);
  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);

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
      imgRef.current  = null;
      topoNodesRef.current = [];
      topoEdgesRef.current = [];
      setMapInfo(null);
      setCanvasReady(false);
      setTopoStats({ n: 0, e: 0 });
      return;
    }

    setCanvasReady(false);
    imgRef.current  = null;
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
      })
      .catch(console.error);

    const img = new Image();
    img.onload  = () => { imgRef.current = img; setCanvasReady(true); };
    img.onerror = () => { setCanvasReady(true); }; // show dark bg + topology
    img.src     = `${base}/api/map/static/${selectedMap}/image`;

    // 토폴로지 로드 (map_id = selectedMap 으로 조회)
    Promise.all([
      fetch(`${base}/api/fleet/topology/nodes?map_id=${selectedMap}`)
        .then(r => r.json()).catch(() => []),
      fetch(`${base}/api/fleet/topology/edges?map_id=${selectedMap}`)
        .then(r => r.json()).catch(() => []),
    ]).then(([ns, es]) => {
      const nodes = Array.isArray(ns) ? ns as FNode[] : [];
      const edges = Array.isArray(es) ? es as FEdge[] : [];
      topoNodesRef.current = nodes;
      topoEdgesRef.current = edges;
      setTopoStats({ n: nodes.length, e: edges.length });
      drawRef.current();
    });
  }, [selectedMap, base]);

  // ── 캔버스 렌더 ───────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const info   = infoRef.current;
    if (!canvas || !info) return;

    const wrap  = wrapRef.current;
    const ww    = wrap?.clientWidth  ?? 600;
    const wh    = wrap?.clientHeight ?? 400;
    const scale = Math.min(ww / info.width, wh / info.height);
    scaleRef.current = scale;

    canvas.width  = Math.floor(info.width  * scale);
    canvas.height = Math.floor(info.height * scale);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    // 배경
    const img = imgRef.current;
    if (img) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#080808";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // ── 경로 그리기 ──────────────────────────────────────────────────────
    for (const robot of TB3_ROBOTS) {
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
      ctx.lineWidth   = isSelected ? 2.5 : 1.2;
      ctx.setLineDash(isSelected ? [4, 3] : [2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      const last = poses[poses.length - 1]?.pose?.position;
      if (last?.x != null) {
        const { cx, cy } = worldToCanvas(last.x, last.y ?? 0, info, scale);
        ctx.beginPath();
        ctx.arc(cx, cy, isSelected ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle   = robot.color + (isSelected ? "44" : "22");
        ctx.fill();
        ctx.strokeStyle = robot.color + (isSelected ? "ee" : "66");
        ctx.lineWidth   = isSelected ? 2 : 1;
        ctx.stroke();
      }
    }

    // ── 토폴로지 오버레이 ─────────────────────────────────────────────────

    if (showTopology) {
      const topoNodes  = topoNodesRef.current;
      const topoEdges  = topoEdgesRef.current;
      const apaths     = activePathsRef.current;
      const robPos     = robotPosRef.current;

      // active 경로 맵 구성
      const robotColorMap: Record<string, string>  = {};
      const activeNodeMap: Record<string, string>  = {};
      const activeEdgeMap: Record<string, string>  = {};
      apaths.forEach(({ robotId, pathQueue, fromNodeId }, i) => {
        robotColorMap[robotId] = ROBOT_COLORS[i % ROBOT_COLORS.length];
        if (fromNodeId) activeNodeMap[fromNodeId] = robotId;
        pathQueue.forEach(id => { activeNodeMap[id] = robotId; });
        const full = fromNodeId ? [fromNodeId, ...pathQueue] : pathQueue;
        for (let j = 0; j < full.length - 1; j++) {
          activeEdgeMap[`${full[j]}→${full[j + 1]}`] = robotId;
        }
      });

      // 엣지 렌더
      topoEdges.forEach(e => {
        const sn = topoNodes.find(n => n.node_id === e.startNode);
        const en = topoNodes.find(n => n.node_id === e.endNode);
        if (!sn || !en) return;

        const { cx: sx, cy: sy } = worldToCanvas(sn.x, sn.y, info, scale);
        const { cx: ex, cy: ey } = worldToCanvas(en.x, en.y, info, scale);

        const fwdKey = `${e.startNode}→${e.endNode}`;
        const bwdKey = `${e.endNode}→${e.startNode}`;
        const ar     = activeEdgeMap[fwdKey] ?? activeEdgeMap[bwdKey];
        const edgeColor = ar ? robotColorMap[ar] : e.isLocked ? "#7f1d1d" : "#4b5563";

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = edgeColor;
        ctx.lineWidth   = ar ? 3.5 : 1.5;
        ctx.globalAlpha = ar ? 0.9 : 0.65;
        ctx.stroke();

        if (e.direction === "ONE_WAY") {
          const angle = Math.atan2(ey - sy, ex - sx);
          const mx = (sx + ex) / 2, my = (sy + ey) / 2;
          const al = ar ? 10 : 7;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(mx - al * Math.cos(angle - 0.4), my - al * Math.sin(angle - 0.4));
          ctx.lineTo(mx - al * Math.cos(angle + 0.4), my - al * Math.sin(angle + 0.4));
          ctx.closePath();
          ctx.fillStyle = edgeColor;
          ctx.fill();
        }

        // 활성 엣지 로봇 라벨
        if (ar) {
          const mx = (sx + ex) / 2, my = (sy + ey) / 2;
          ctx.globalAlpha  = 1;
          ctx.font         = "bold 8px monospace";
          ctx.fillStyle    = robotColorMap[ar];
          ctx.textAlign    = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(ar, mx, my - 3);
        }
        ctx.restore();
      });

      // 노드 렌더
      topoNodes.forEach(n => {
        const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
        const ar  = activeNodeMap[n.node_id];
        const rc  = ar ? robotColorMap[ar] : null;
        const isHov = n.node_id === hoveredNodeId;
        const r   = rc ? 9 : isHov ? 8 : 6;

        if (rc) {
          ctx.beginPath();
          ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
          ctx.fillStyle = rc + "33";
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = NODE_COLOR[n.type] ?? "#888";
        ctx.fill();

        if (rc || isHov) {
          ctx.strokeStyle = rc ?? "#fff";
          ctx.lineWidth   = rc ? 2.5 : 1.5;
          ctx.stroke();
        }

        // 라벨
        ctx.fillStyle    = rc ?? (isHov ? "#fff" : "#ffffffcc");
        ctx.font         = rc ? "bold 9px monospace" : "9px monospace";
        ctx.textAlign    = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(n.node_id, cx + r + 2, cy);
      });

      // 로봇 실제 위치 점 (FMS task 기반)
      Object.entries(robPos).forEach(([robotId, pos], i) => {
        const color = robotColorMap[robotId] ?? ROBOT_COLORS[i % ROBOT_COLORS.length];
        const { cx, cy } = worldToCanvas(pos.x, pos.y, info, scale);
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle   = color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        ctx.font         = "bold 9px monospace";
        ctx.fillStyle    = color;
        ctx.textAlign    = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(robotId, cx, cy - 8);
      });
    }

    // ── 로봇 마커 (amcl_pose) ─────────────────────────────────────────────
    for (const robot of TB3_ROBOTS) {
      const amcl = rosMessages[`/${robot.id}/amcl_pose`]?.data as {
        pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } }
      } | undefined;
      const pos = amcl?.pose?.pose?.position;
      const ori = amcl?.pose?.pose?.orientation;
      if (pos?.x == null) continue;

      const { cx, cy } = worldToCanvas(pos.x, pos.y ?? 0, info, scale);
      const yaw = ori ? quatToYaw({ x: ori.x ?? 0, y: ori.y ?? 0, z: ori.z ?? 0, w: ori.w ?? 1 }) : 0;
      drawRobotMarker(ctx, cx, cy, yaw, robot.color, robot.label, selectedBots.has(robot.id));
    }

    // ── 드래그 중 프리뷰 ─────────────────────────────────────────────────
    if (dragRef.current) {
      const { sx, sy, cx, cy, type } = dragRef.current;
      const dx = cx - sx, dy = cy - sy;
      const yaw = (Math.abs(dx) + Math.abs(dy)) > 5 ? Math.atan2(dy, dx) : 0;
      const previewColor = type === "goal" ? "#ef4444" : type === "home" ? "#4ade80" : "#22d3ee";
      drawPreviewMarker(ctx, sx, sy, yaw, previewColor, type === "goal" ? "goal" : "pose");
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
    const info  = infoRef.current;
    const scale = scaleRef.current;

    // 노드 클릭 우선 처리
    if (showTopology && onNodeClickRef.current && info) {
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
    const type = e.button === 2 ? "pose" : homeMode ? "home" : "goal";
    dragRef.current = { sx: x, sy: y, cx: x, cy: y, type };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasXY(e);
    const info  = infoRef.current;
    const scale = scaleRef.current;

    // hover 노드 감지
    if (showTopology && info) {
      for (const n of topoNodesRef.current) {
        const { cx, cy } = worldToCanvas(n.x, n.y, info, scale);
        if (Math.hypot(x - cx, y - cy) <= 12) {
          if (hoveredNodeId !== n.node_id) setHoveredNodeId(n.node_id);
          if (dragRef.current) { dragRef.current = { ...dragRef.current, cx: x, cy: y }; draw(); }
          return;
        }
      }
    }
    if (hoveredNodeId) setHoveredNodeId(null);

    if (!dragRef.current) return;
    dragRef.current = { ...dragRef.current, cx: x, cy: y };
    draw();
  };

  const onMouseUp = () => {
    if (!dragRef.current || !infoRef.current) return;
    const { sx, sy, cx, cy, type } = dragRef.current;
    dragRef.current = null;

    const info  = infoRef.current;
    const scale = scaleRef.current;
    const { wx, wy } = canvasToWorld(sx, sy, info, scale);
    const dx = cx - sx, dy = cy - sy;
    const yaw = (Math.abs(dx) + Math.abs(dy)) > 5 ? Math.atan2(-dy, dx) : 0;

    for (const id of selectedBots) {
      if (type === "goal")      onSendGoal(id, wx, wy, yaw);
      else if (type === "home") onSetHome?.(id, wx, wy, yaw);
      else                      onSetInitialPose(id, wx, wy, yaw);
    }
    draw();
  };

  const onMouseLeave = () => {
    dragRef.current = null;
    if (hoveredNodeId) setHoveredNodeId(null);
    draw();
  };
  const onContextMenu = (e: React.MouseEvent) => e.preventDefault();

  const cameraBot      = TB3_ROBOTS.find((r) => selectedBots.has(r.id))?.id ?? "tb3_01";
  const cameraRobotMeta = TB3_ROBOTS.find((r) => r.id === cameraBot);
  const soloBot         = selectedBots.size === 1 ? [...selectedBots][0] : null;
  const selectedPlanPoses = soloBot
    ? (rosMessages[`/${soloBot}/plan`]?.data as { poses?: unknown[] } | undefined)?.poses
    : undefined;

  // hover 중인 노드 정보
  const hNode = hoveredNodeId ? topoNodesRef.current.find(n => n.node_id === hoveredNodeId) : null;

  return (
    <div className="flex flex-col h-full bg-[#050505]">

      {/* ── 툴바 ──────────────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-[#111] bg-[#080808] flex-wrap">

        {/* 맵 선택 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest">MAP</span>
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
            className={`text-[10px] font-mono bg-[#0d0d0d] border text-[#aaa] px-2 py-0.5 max-w-[160px] truncate ${
              assignLoading ? "border-amber-700/50 text-amber-400" : "border-[#1e1e1e]"
            }`}
          >
            {availableMaps.length === 0 && <option value="">맵 없음</option>}
            {availableMaps.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {assignLoading && (
            <span className="text-[9px] font-mono text-amber-400/70 animate-pulse">로딩...</span>
          )}
        </div>

        <div className="w-px h-4 bg-[#1a1a1a]" />

        {/* 로봇 선택 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest">ROBOT</span>
          <div className="flex">
            <button
              onClick={() => {
                const allIds = TB3_ROBOTS.map((r) => r.id);
                const allSelected = allIds.every((id) => selectedBots.has(id));
                setSelectedBots(allSelected ? new Set() : new Set(allIds));
              }}
              className={`px-2 py-0.5 text-[9px] font-mono font-bold border-r border-[#1a1a1a] transition-all ${
                TB3_ROBOTS.every((r) => selectedBots.has(r.id))
                  ? "bg-white text-black"
                  : "text-[#555] hover:text-[#aaa]"
              }`}
            >
              ALL
            </button>
            {TB3_ROBOTS.map((r) => {
              const isOn    = selectedBots.has(r.id);
              const hasPos  = rosMessages[`/${r.id}/amcl_pose`]?.data != null;
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
                  className="relative px-2 py-0.5 text-[9px] font-mono font-bold border-r border-[#1a1a1a] last:border-0 transition-all"
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
                      className="absolute -bottom-3 left-0 right-0 text-center text-[7px] font-mono text-[#555] truncate"
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

        <div className="w-px h-4 bg-[#1a1a1a]" />

        {/* 조작 토글 */}
        <button
          onClick={() => setInteractive((v) => !v)}
          className={`px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
            interactive
              ? "border-blue-900/50 text-blue-400 bg-blue-950/20"
              : "border-[#1a1a1a] text-[#333] hover:text-[#666]"
          }`}
        >
          {interactive ? "● 조작 중" : "○ 보기"}
        </button>

        {/* 홈 설정 */}
        {onSetHome && interactive && (
          <button
            onClick={() => setHomeMode((v) => !v)}
            className={`px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
              homeMode
                ? "border-green-700/60 text-green-400 bg-green-950/20"
                : "border-[#1a1a1a] text-[#333] hover:text-[#666]"
            }`}
          >
            {homeMode ? "● 홈 설정" : "⌂ 홈"}
          </button>
        )}

        {/* 토폴로지 토글 */}
        <button
          onClick={() => setShowTopology((v) => !v)}
          className={`px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
            showTopology
              ? "border-amber-900/50 text-amber-400 bg-amber-950/20"
              : "border-[#1a1a1a] text-[#333] hover:text-[#666]"
          }`}
          title={`노드 ${topoStats.n}개 / 엣지 ${topoStats.e}개`}
        >
          ⬡ 노드{topoStats.n > 0 ? ` ${topoStats.n}` : ""}
        </button>

        {/* 조작 힌트 */}
        {interactive && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-[9px] font-mono">
              <kbd className="px-1 py-0.5 border border-[#222] text-[#444] text-[8px]">L</kbd>
              <span className={homeMode ? "text-green-400/70" : "text-red-400/70"}>
                {homeMode ? "홈" : "목표"}
              </span>
            </span>
            <span className="flex items-center gap-1 text-[9px] font-mono">
              <kbd className="px-1 py-0.5 border border-[#222] text-[#444] text-[8px]">R</kbd>
              <span className="text-cyan-400/70">초기위치</span>
            </span>
          </div>
        )}

        {showTopology && onNodeClick && (
          <span className="text-[9px] font-mono text-amber-400/60">
            노드 클릭 → 태스크 목표 설정
          </span>
        )}

        {/* 카메라 토글 */}
        <button
          onClick={() => setShowCamera((v) => !v)}
          className={`ml-auto px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
            showCamera
              ? "border-green-900/50 text-green-400 bg-green-950/20"
              : "border-[#1a1a1a] text-[#333] hover:text-[#666]"
          }`}
        >
          ◉ CAM
        </button>
      </div>

      {/* ── 본문 ─────────────────────────────────────────────────────────── */}
      <div ref={wrapRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-[#020202]">

        {!canvasReady ? (
          <span className="text-[10px] font-mono text-[#333] uppercase tracking-widest">
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
          <div className="absolute top-2 right-2 bg-black/80 border border-[#222] px-2 py-1.5 pointer-events-none">
            <div className="text-[10px] font-mono font-bold" style={{ color: NODE_COLOR[hNode.type] ?? "#888" }}>
              {hNode.node_id}
            </div>
            <div className="text-[9px] font-mono text-[#666] mt-0.5">
              x={hNode.x.toFixed(3)}  y={hNode.y.toFixed(3)}
            </div>
            <div className="text-[9px] font-mono text-[#666]">
              yaw={hNode.yaw.toFixed(3)}  <span style={{ color: NODE_COLOR[hNode.type] }}>{hNode.type}</span>
            </div>
            {onNodeClick && (
              <div className="text-[8px] font-mono text-amber-400/70 mt-0.5">클릭하여 목표 설정</div>
            )}
          </div>
        )}

        {/* 카메라 오버레이 */}
        {showCamera && socket && canvasReady && (
          <div className="absolute bottom-3 right-3 w-56 z-10 shadow-2xl shadow-black/80 border border-[#222]">
            <div className="flex items-center justify-between px-2 py-1 bg-[#0a0a0a] border-b border-[#1a1a1a]">
              <span
                className="text-[9px] font-mono font-bold uppercase tracking-widest"
                style={{ color: cameraRobotMeta?.color ?? "#888" }}
              >
                ◉ {cameraRobotMeta?.label ?? cameraBot}{selectedBots.size > 1 && ` (+${selectedBots.size - 1})`}
              </span>
              <button onClick={() => setShowCamera(false)} className="text-[9px] text-[#333] hover:text-[#888]">✕</button>
            </div>
            <CameraFeed botId={cameraBot} label={cameraRobotMeta?.label ?? cameraBot} socket={socket} />
          </div>
        )}

        {/* 범례 (좌상단) */}
        {canvasReady && (
          <div className="absolute top-2 left-2 flex flex-col gap-1 bg-[#050505]/90 px-2 py-1.5 border border-[#111]">
            {TB3_ROBOTS.map((r) => {
              const isOn   = selectedBots.has(r.id);
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
                  <span className={`text-[8px] font-mono ${hasPos ? "text-[#888]" : "text-[#2a2a2a]"}`}>{r.label}</span>
                  {hasPlan && <span className="text-[6px]" style={{ color: r.color }}>▶ 경로</span>}
                </button>
              );
            })}
            {/* 토폴로지 범례 */}
            {showTopology && topoStats.n > 0 && (
              <>
                <div className="h-px bg-[#1a1a1a] my-0.5" />
                {(["WAYPOINT","STATION","CHARGER"] as const).map(t => (
                  <div key={t} className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full flex-none" style={{ background: NODE_COLOR[t] }} />
                    <span className="text-[7px] font-mono text-[#444]">{t}</span>
                  </div>
                ))}
                <div className="text-[7px] font-mono text-[#333]">E:{topoStats.e}</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── 하단 정보 바 ─────────────────────────────────────────────────── */}
      {mapInfo && (
        <div className="flex-none flex gap-4 px-3 py-1 border-t border-[#0a0a0a] bg-[#070707] text-[9px] font-mono text-[#2a2a2a]">
          <span className="text-[#333]">{selectedMap}</span>
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
  ctx.fillStyle   = color + (selected ? "cc" : "88");
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = selected ? 2.5 : 1.5;
  ctx.stroke();

  const len = r + 10;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(-yaw) * len, Math.sin(-yaw) * len);
  ctx.strokeStyle = color;
  ctx.lineWidth   = selected ? 2.5 : 1.5;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font      = `bold ${selected ? 10 : 8}px monospace`;
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
  ctx.fillStyle   = color + "33";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.setLineDash([3, 2]);
  ctx.stroke();
  ctx.setLineDash([]);

  const len = 24;
  const hx  = Math.cos(yaw) * len;
  const hy  = Math.sin(yaw) * len;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(hx, hy);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
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
  ctx.font      = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.fillText(type === "goal" ? "GOAL" : "INIT", 0, -15);

  ctx.restore();
}
