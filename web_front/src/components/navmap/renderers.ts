// NavMapCanvas 의 draw() 내부 렌더 섹션을 순수 함수로 분리.
// 모든 함수는 ctx + 필요한 데이터만 인자로 받아 동작이 동일하도록 유지한다.
import { RosMessage } from "../../hooks/useNestSocket";
import type { FNode, FEdge, ActivePath, RobotPos } from "../TopologyMapView";
import type { StaticMapInfo } from "./types";
import { TB3_ROBOTS, NODE_COLOR, ROBOT_COLORS, CHARGE_PATH_COLOR } from "./constants";
import { worldToCanvas, quatToYaw } from "./geometry";
import { drawRobotMarker } from "./markers";

// 현재 맵에 배정된 활성 경로만 추리고, 로봇별 경로 색을 계산.
// (충전 임무는 전용 색, 그 외는 로봇별 색 순환)
export function buildActivePathColors(
  activePaths: ActivePath[],
  assignments: Record<string, string>,
  selectedMap: string,
) {
  const filteredApaths = activePaths.filter(({ robotId }) => {
    const assigned = assignments[robotId];
    return !assigned || assigned === selectedMap;
  });
  const robotColorMap: Record<string, string> = {};
  filteredApaths.forEach(({ robotId, taskType }, i) => {
    robotColorMap[robotId] = taskType === "CHARGE" ? CHARGE_PATH_COLOR : ROBOT_COLORS[i % ROBOT_COLORS.length];
  });
  return { filteredApaths, robotColorMap };
}

// ── TB3 계획 경로(/plan) ───────────────────────────────────────────────
export function drawPlanPaths(
  ctx: CanvasRenderingContext2D,
  info: StaticMapInfo,
  scale: number,
  rosMessages: Record<string, RosMessage>,
  assignments: Record<string, string>,
  selectedMap: string,
  selectedBots: Set<string>,
) {
  for (const robot of TB3_ROBOTS) {
    const robotAssignedMap = assignments[robot.id];
    if (robotAssignedMap && robotAssignedMap !== selectedMap) continue;
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
}

// ── 토폴로지 오버레이 (엣지 + 노드 + 비-TB3 로봇) ──────────────────────
export function drawTopologyOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  info: StaticMapInfo,
  scale: number,
  data: {
    topoNodes: FNode[];
    topoEdges: FEdge[];
    robPos: Record<string, RobotPos>;
    filteredApaths: ActivePath[];
    robotColorMap: Record<string, string>;
    hoveredNodeId: string | null;
    lockedSet: Set<string>;
    rosMessages: Record<string, RosMessage>;
  },
) {
  const { topoNodes, topoEdges, robPos, filteredApaths, robotColorMap, hoveredNodeId, lockedSet, rosMessages } = data;

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

// ── 활성 경로 오버레이 (전체 경로 + 현재 goal 시각화) ──────────────────
export function drawActivePaths(
  ctx: CanvasRenderingContext2D,
  info: StaticMapInfo,
  scale: number,
  data: {
    filteredApaths: ActivePath[];
    robotColorMap: Record<string, string>;
    rosMessages: Record<string, RosMessage>;
    topoNodes: FNode[];
  },
) {
  const { filteredApaths, robotColorMap, rosMessages, topoNodes } = data;

  for (const { robotId, pathQueue, fullPath } of filteredApaths) {
    const color = robotColorMap[robotId];
    if (!color || pathQueue.length === 0) continue;

    // 로봇 현재 위치 (AMCL)
    const amclMsg = rosMessages[`/${robotId}/amcl_pose`]?.data as any;
    const amclPos = amclMsg?.pose?.pose?.position;
    const robotPt = amclPos?.x != null ? worldToCanvas(amclPos.x, amclPos.y, info, scale) : null;

    type WPt = { cx: number; cy: number; nodeId: string; yaw: number };
    const toWPt = (nodeId: string): WPt | null => {
      const node = topoNodes.find(n => n.node_id === nodeId);
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
}

// ── TB3 로봇 마커 (amcl_pose, 현재 맵 배정 로봇만) ──────────────────────
export function drawTb3Markers(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  info: StaticMapInfo,
  scale: number,
  rosMessages: Record<string, RosMessage>,
  assignments: Record<string, string>,
  selectedMap: string,
  selectedBots: Set<string>,
) {
  for (const robot of TB3_ROBOTS) {
    const robotAssignedMap2 = assignments[robot.id];
    if (robotAssignedMap2 && robotAssignedMap2 !== selectedMap) continue;
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
}
