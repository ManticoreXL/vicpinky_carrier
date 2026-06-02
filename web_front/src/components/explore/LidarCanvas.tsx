import { useRef, useEffect } from "react";

interface ScanData {
  angle_min?: number;
  angle_increment?: number;
  range_min?: number;
  range_max?: number;
  ranges?: number[];
}

interface Props {
  scanData: ScanData | undefined;
  size?: number;
}

export default function LidarCanvas({ scanData, size = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const rMax = scanData?.range_max ?? 3.5;
    const rMin = scanData?.range_min ?? 0.12;
    const pad  = 24;
    const scale = (Math.min(w, h) / 2 - pad) / rMax;

    // Background
    ctx.fillStyle = "#030712";
    ctx.fillRect(0, 0, w, h);

    // Danger zone fill (< 0.5m)
    ctx.beginPath();
    ctx.arc(cx, cy, 0.5 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(239,68,68,0.06)";
    ctx.fill();

    // Grid rings
    [1, 2, 3, rMax].forEach((r) => {
      if (r > rMax + 0.01) return;
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
      ctx.strokeStyle = r === rMax ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash(r === rMax ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(239,68,68,0.45)";
      ctx.font = "9px monospace";
      ctx.fillText(`${r === rMax ? r.toFixed(1) : r}m`, cx + r * scale + 3, cy - 3);
    });

    // Crosshair
    ctx.strokeStyle = "rgba(239,68,68,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx, h - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, cy); ctx.lineTo(w - pad, cy); ctx.stroke();

    // Direction labels
    ctx.fillStyle = "rgba(239,68,68,0.55)";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("▲ F", cx, pad - 4);
    ctx.fillText("▼ B", cx, h - 6);
    ctx.textAlign = "right";
    ctx.fillText("R ▶", w - 6, cy + 4);
    ctx.textAlign = "left";
    ctx.fillText("◀ L", 6, cy + 4);
    ctx.textAlign = "left";

    const ranges = scanData?.ranges ?? [];

    if (ranges.length === 0) {
      ctx.fillStyle = "rgba(239,68,68,0.3)";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("NO SIGNAL", cx, cy - 8);
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(239,68,68,0.2)";
      ctx.fillText("대기 중...", cx, cy + 10);
      ctx.textAlign = "left";
    } else {
      const angleMin = scanData?.angle_min ?? -Math.PI;
      const angleInc = scanData?.angle_increment ?? (2 * Math.PI / ranges.length);

      // Filled area
      ctx.beginPath();
      let first = true;
      ranges.forEach((r, i) => {
        if (!isFinite(r) || r < rMin || r > rMax) return;
        const angle = angleMin + i * angleInc;
        // Forward = up: x = cx - sin(angle)*r*scale, y = cy - cos(angle)*r*scale
        const x = cx - Math.sin(angle) * r * scale;
        const y = cy - Math.cos(angle) * r * scale;
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(239,68,68,0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(239,68,68,0.25)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Individual points
      ranges.forEach((r, i) => {
        if (!isFinite(r) || r < rMin || r > rMax) return;
        const angle = angleMin + i * angleInc;
        const x = cx - Math.sin(angle) * r * scale;
        const y = cy - Math.cos(angle) * r * scale;
        const color =
          r < 0.3  ? "#ff2222" :
          r < 0.6  ? "#ff6600" :
          r < 1.2  ? "#ef4444" : "#7f1d1d";
        ctx.fillStyle = color;
        ctx.fillRect(x - 1, y - 1, 2, 2);
      });
    }

    // Robot body
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
    ctx.fillStyle = "#16a34a";
    ctx.fill();
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Forward arrow
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy - 16);
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 13);
    ctx.lineTo(cx, cy - 18);
    ctx.lineTo(cx + 3, cy - 13);
    ctx.fillStyle = "#4ade80";
    ctx.fill();

  }, [scanData]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="rounded-lg block"
    />
  );
}
