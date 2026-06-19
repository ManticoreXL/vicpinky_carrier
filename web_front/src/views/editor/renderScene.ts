// TopologyEditor 캔버스 렌더 — 컴포넌트에서 분리한 순수 드로잉 로직.
// 계산된 ViewState 를 반환하여 호출측에서 히트테스트용 viewRef 에 저장한다.
import type { MapInfo, FNode, FEdge, ViewState } from "./types";
import { worldToCanvas } from "./geometry";
import { NODE_COLOR } from "./constants";

export interface RenderOpts {
  selNodeId: string | null;
  selEdgeId: string | null;
  edgeStart: string | null;
  hover: [number, number] | null;
  hoverNode: FNode | null;
  dragNodeId: string | null;
  hasDragged: boolean;
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  img: HTMLImageElement | null,
  mapInfo: MapInfo,
  nodes: FNode[],
  edges: FEdge[],
  opts: RenderOpts,
): ViewState {
  const { selNodeId, selEdgeId, edgeStart, hover, hoverNode, dragNodeId, hasDragged } = opts;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = "#241509";
  ctx.fillRect(0, 0, W, H);

  const scale = Math.min(W / mapInfo.width, H / mapInfo.height) * 0.95;
  const offX = (W - mapInfo.width * scale) / 2;
  const offY = (H - mapInfo.height * scale) / 2;
  const view: ViewState = { scale, offX, offY, info: mapInfo };

  if (img) {
    ctx.drawImage(img, offX, offY, mapInfo.width * scale, mapInfo.height * scale);
  } else {
    ctx.fillStyle = "#3a2414";
    ctx.fillRect(offX, offY, mapInfo.width * scale, mapInfo.height * scale);
  }

  // 엣지 렌더
  edges.forEach(e => {
    const sn = nodes.find(n => n.node_id === e.startNode);
    const en = nodes.find(n => n.node_id === e.endNode);
    if (!sn || !en) return;
    const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
    const [ex, ey] = worldToCanvas(en.x, en.y, view);

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    const isSel = e.edge_id === selEdgeId;
    ctx.strokeStyle = e.isLocked ? "#6b2424" : isSel ? "#f59e0b" : "#4b5563";
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.stroke();

    if (e.direction === "ONE_WAY") {
      const angle = Math.atan2(ey - sy, ex - sx);
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const alen = 8;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - alen * Math.cos(angle - 0.4), my - alen * Math.sin(angle - 0.4));
      ctx.lineTo(mx - alen * Math.cos(angle + 0.4), my - alen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
  });

  // 엣지 그리기 진행 중 선
  if (edgeStart && hover) {
    const sn = nodes.find(n => n.node_id === edgeStart);
    if (sn) {
      const [sx, sy] = worldToCanvas(sn.x, sn.y, view);
      const [hx, hy] = worldToCanvas(hover[0], hover[1], view);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 노드 렌더
  nodes.forEach(n => {
    const [cx, cy] = worldToCanvas(n.x, n.y, view);
    const isDragTarget = n.node_id === dragNodeId && hasDragged;
    const r = (n.node_id === selNodeId || isDragTarget) ? 9 : 7;
    const isEdgeStartNode = n.node_id === edgeStart;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = NODE_COLOR[n.type] ?? "#888";
    if (isDragTarget) ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (n.node_id === selNodeId || isEdgeStartNode || isDragTarget) {
      ctx.strokeStyle = isDragTarget ? "#f59e0b" : "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const yawX = cx + Math.cos(n.yaw) * (r + 5);
    const yawY = cy - Math.sin(n.yaw) * (r + 5);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(yawX, yawY);
    ctx.strokeStyle = "#ffffff88";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#ffffffcc";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(n.node_id, cx + r + 2, cy);
  });

  // 십자선 + 호버 툴팁
  if (hover) {
    const [hx, hy] = worldToCanvas(hover[0], hover[1], view);
    ctx.strokeStyle = "#ffffff22";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();

    if (hoverNode) {
      const lines = [
        `x ${hoverNode.x.toFixed(3)}`,
        `y ${hoverNode.y.toFixed(3)}`,
        `yaw ${hoverNode.yaw.toFixed(3)} rad`,
      ];
      const pad = 7;
      const lh = 14;
      const bw = 148;
      const bh = pad * 2 + lh * (lines.length + 1);
      let tx = hx + 16;
      let ty = hy - bh / 2;
      if (tx + bw > W) tx = hx - bw - 16;
      if (ty < 2) ty = 2;
      if (ty + bh > H - 2) ty = H - bh - 2;

      ctx.fillStyle = "rgba(8,8,8,0.88)";
      ctx.fillRect(tx, ty, bw, bh);
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, bw, bh);
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = NODE_COLOR[hoverNode.type] ?? "#888";
      ctx.fillText(hoverNode.node_id, tx + pad, ty + pad);
      ctx.font = "10px monospace";
      ctx.fillStyle = "#aaaaaa";
      lines.forEach((line, i) => {
        ctx.fillText(line, tx + pad, ty + pad + lh * (i + 1));
      });
    }
  }

  return view;
}
