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
    const rMax  = scanData?.range_max ?? 3.5;
    const rMin  = scanData?.range_min ?? 0.12;
    const pad   = 22;
    const scale = (Math.min(w, h) / 2 - pad) / rMax;

    // Background — pitch black
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);

    // Danger zone fill (<0.4m)
    ctx.beginPath();
    ctx.arc(cx, cy, 0.4 * scale, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(185,28,28,0.10)";
    ctx.fill();

    // Grid rings — dark red / silver
    [1, 2, 3, rMax].forEach((r) => {
      if (r > rMax + 0.01) return;
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, 2 * Math.PI);
      ctx.strokeStyle = r === rMax ? "rgba(185,28,28,0.55)" : "rgba(185,28,28,0.18)";
      ctx.lineWidth = r === rMax ? 1 : 0.5;
      ctx.setLineDash(r === rMax ? [] : [3, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(100,100,100,0.55)";
      ctx.font = "8px monospace";
      ctx.fillText(`${r === rMax ? r.toFixed(1) : r}m`, cx + r * scale + 3, cy - 2);
    });

    // Crosshair — faint silver
    ctx.strokeStyle = "rgba(70,70,70,0.3)";
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx, h - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, cy); ctx.lineTo(w - pad, cy); ctx.stroke();

    // Direction labels
    ctx.fillStyle = "rgba(185,28,28,0.65)";
    ctx.font = "bold 9px monospace";
    ctx.textAlign = "center";
    ctx.fillText("F", cx, pad - 5);
    ctx.fillText("B", cx, h - 4);
    ctx.textAlign = "right";
    ctx.fillText("R", w - 4, cy + 4);
    ctx.textAlign = "left";
    ctx.fillText("L", 4, cy + 4);
    ctx.textAlign = "left";

    const ranges = scanData?.ranges ?? [];

    if (ranges.length === 0) {
      ctx.fillStyle = "rgba(185,28,28,0.45)";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("NO SIGNAL", cx, cy - 6);
      ctx.font = "9px monospace";
      ctx.fillStyle = "rgba(80,80,80,0.5)";
      ctx.fillText("WAITING...", cx, cy + 10);
      ctx.textAlign = "left";
    } else {
      const angleMin = scanData?.angle_min ?? -Math.PI;
      const angleInc = scanData?.angle_increment ?? (2 * Math.PI / ranges.length);

      // Filled scan area
      ctx.beginPath();
      let first = true;
      ranges.forEach((r, i) => {
        if (!isFinite(r) || r < rMin || r > rMax) return;
        const angle = angleMin + i * angleInc;
        const x = cx - Math.sin(angle) * r * scale;
        const y = cy - Math.cos(angle) * r * scale;
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(185,28,28,0.07)";
      ctx.fill();
      ctx.strokeStyle = "rgba(185,28,28,0.22)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Points — silver near robot, bright red up close
      ranges.forEach((r, i) => {
        if (!isFinite(r) || r < rMin || r > rMax) return;
        const angle = angleMin + i * angleInc;
        const x = cx - Math.sin(angle) * r * scale;
        const y = cy - Math.cos(angle) * r * scale;
        const color =
          r < 0.3  ? "#ff0000" :
          r < 0.6  ? "#cc1111" :
          r < 1.5  ? "#881111" : "#4a4a4a";
        ctx.fillStyle = color;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      });
    }

    // Robot body — silver square with red outline
    ctx.fillStyle = "#c0c0c0";
    ctx.fillRect(cx - 5, cy - 5, 10, 10);
    ctx.strokeStyle = "#b91c1c";
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 5, cy - 5, 10, 10);

    // Forward indicator — red arrow
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy - 15);
    ctx.strokeStyle = "#b91c1c";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#b91c1c";
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 12);
    ctx.lineTo(cx, cy - 18);
    ctx.lineTo(cx + 3, cy - 12);
    ctx.fill();

  }, [scanData]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="block"
    />
  );
}
