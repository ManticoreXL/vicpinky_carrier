// 로봇/프리뷰 마커 드로잉 헬퍼 (순수 함수)

export function drawRobotMarker(
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

export function drawPreviewMarker(
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
