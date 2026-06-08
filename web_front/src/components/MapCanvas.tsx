import { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import type { MapInfo } from "../hooks/useNestSocket";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface MapCanvasHandle {
  downloadPng: (filename?: string) => void;
}

export interface Point2D {
  x: number;
  y: number;
}

interface Props {
  imageUrl: string | null;   // 백엔드 /api/map/:botId/image URL
  mapInfo?: MapInfo;          // 로봇 오버레이용 메타데이터
  robotX?: number;            // map 프레임 좌표 (m)
  robotY?: number;
  robotYaw?: number;          // rad
  scanPoints?: Point2D[];     // 라이다 스캔 점 (map 프레임, m)
  pathPoints?: Point2D[];     // 경로 (map 프레임, m)
  size?: number;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

const MapCanvas = forwardRef<MapCanvasHandle, Props>(
  ({ imageUrl, mapInfo, robotX, robotY, robotYaw, scanPoints, pathPoints, size = 320 }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // PNG 다운로드: canvas에 이미 그려진 내용을 blob으로 추출
    useImperativeHandle(ref, () => ({
      downloadPng: (filename = "slam_map.png") => {
        canvasRef.current?.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        }, "image/png");
      },
    }));

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, size, size);

      if (!imageUrl) {
        ctx.fillStyle = "rgba(185,28,28,0.45)";
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "center";
        ctx.fillText("MAP NO DATA", size / 2, size / 2 - 6);
        ctx.font = "9px monospace";
        ctx.fillStyle = "rgba(80,80,80,0.5)";
        ctx.fillText("WAITING...", size / 2, size / 2 + 10);
        ctx.textAlign = "left";
        return;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!canvasRef.current) return;
        const c = canvasRef.current.getContext("2d")!;
        c.fillStyle = "#050505";
        c.fillRect(0, 0, size, size);
        c.imageSmoothingEnabled = false;
        c.drawImage(img, 0, 0, size, size);

        // world(map 프레임, m) → canvas 픽셀 변환 헬퍼
        const toPx = (wx: number, wy: number, info: MapInfo): [number, number] => {
          const sx = size / info.width;
          const sy = size / info.height;
          const cellX = (wx - info.origin.position.x) / info.resolution;
          const cellY = (wy - info.origin.position.y) / info.resolution;
          return [cellX * sx, (info.height - cellY) * sy]; // Y 반전
        };

        // ── 경로(/plan) 오버레이 — 맨 아래 ──
        if (pathPoints && pathPoints.length > 1 && mapInfo) {
          c.beginPath();
          pathPoints.forEach((p, i) => {
            const [px, py] = toPx(p.x, p.y, mapInfo);
            if (i === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
          });
          c.strokeStyle = "rgba(56,189,248,0.9)"; // cyan
          c.lineWidth = 2;
          c.stroke();
        }

        // ── 라이다 스캔 오버레이 ──
        if (scanPoints && scanPoints.length && mapInfo) {
          c.fillStyle = "rgba(34,197,94,0.85)"; // green
          for (const p of scanPoints) {
            const [px, py] = toPx(p.x, p.y, mapInfo);
            c.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
          }
        }

        // 로봇 위치 오버레이
        if (robotX !== undefined && robotY !== undefined && mapInfo) {
          const { width, height, resolution, origin } = mapInfo;
          const sx = size / width;
          const sy = size / height;
          const cellX = (robotX - origin.position.x) / resolution;
          const cellY = (robotY - origin.position.y) / resolution;
          const px = cellX * sx;
          const py = (height - cellY) * sy; // canvas Y 반전

          // 외부 링
          c.beginPath();
          c.arc(px, py, 9, 0, Math.PI * 2);
          c.strokeStyle = "rgba(255,255,255,0.4)";
          c.lineWidth = 1;
          c.stroke();

          // 로봇 본체
          c.beginPath();
          c.arc(px, py, 6, 0, Math.PI * 2);
          c.fillStyle = "rgba(239,68,68,0.95)";
          c.fill();
          c.strokeStyle = "#fff";
          c.lineWidth = 1.5;
          c.stroke();

          // 방향 화살표
          if (robotYaw !== undefined) {
            const len = 14;
            c.beginPath();
            c.moveTo(px, py);
            c.lineTo(px + len * Math.cos(robotYaw), py - len * Math.sin(robotYaw));
            c.strokeStyle = "#fff";
            c.lineWidth = 2;
            c.stroke();
          }
        }
      };
      img.onerror = () => {
        const c = canvasRef.current?.getContext("2d");
        if (!c) return;
        c.fillStyle = "#050505";
        c.fillRect(0, 0, size, size);
        c.fillStyle = "rgba(80,80,80,0.4)";
        c.font = "9px monospace";
        c.textAlign = "center";
        c.fillText("MAP LOADING...", size / 2, size / 2);
        c.textAlign = "left";
      };
      img.src = imageUrl;
    }, [imageUrl, robotX, robotY, robotYaw, scanPoints, pathPoints, mapInfo, size]);

    return <canvas ref={canvasRef} width={size} height={size} className="block" />;
  },
);

MapCanvas.displayName = "MapCanvas";
export default MapCanvas;
