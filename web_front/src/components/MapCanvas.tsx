import { useRef, useEffect, forwardRef, useImperativeHandle } from "react";

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface OccupancyGridMsg {
  info: {
    resolution: number;
    width: number;
    height: number;
    origin: {
      position: { x: number; y: number; z: number };
      orientation: { x: number; y: number; z: number; w: number };
    };
  };
  data: number[]; // int8[]: -1=unknown, 0=free, 1-100=occupied
}

export interface MapCanvasHandle {
  downloadPng: (filename?: string) => void;
}

interface Props {
  mapData: OccupancyGridMsg | undefined;
  robotX?: number;   // map 프레임 좌표 (m)
  robotY?: number;
  robotYaw?: number; // rad
  size?: number;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

const MapCanvas = forwardRef<MapCanvasHandle, Props>(
  ({ mapData, robotX, robotY, robotYaw, size = 360 }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useImperativeHandle(ref, () => ({
      downloadPng: (filename = "slam_map.png") => {
        canvasRef.current?.toBlob((blob) => {
          if (!blob) return;
          triggerDownload(URL.createObjectURL(blob), filename);
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

      if (!mapData || !mapData.data?.length) {
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

      const { info, data } = mapData;
      const { width, height, resolution, origin } = info;

      // OccupancyGrid → ImageData (수직 반전: row 0 = 남쪽 → canvas row 0 = 상단)
      const imageData = ctx.createImageData(width, height);
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const srcIdx = (height - 1 - row) * width + col;
          const val = data[srcIdx] ?? -1;

          let grey: number;
          if (val < 0) {
            grey = 127; // unknown → 회색
          } else {
            // 0=free→밝음, 100=occupied→어둠
            grey = Math.round((1 - Math.max(0, Math.min(100, val)) / 100) * 240);
          }

          const dstIdx = (row * width + col) * 4;
          imageData.data[dstIdx]     = grey;
          imageData.data[dstIdx + 1] = grey;
          imageData.data[dstIdx + 2] = grey;
          imageData.data[dstIdx + 3] = 255;
        }
      }

      // 오프스크린 캔버스에 그린 뒤 스케일링
      const offscreen = new OffscreenCanvas(width, height);
      const offCtx = offscreen.getContext("2d")!;
      offCtx.putImageData(imageData, 0, 0);

      const scale = Math.min(size / width, size / height);
      const drawW = width  * scale;
      const drawH = height * scale;
      const ox    = (size - drawW) / 2;
      const oy    = (size - drawH) / 2;

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreen, ox, oy, drawW, drawH);

      // 테두리
      ctx.strokeStyle = "rgba(185,28,28,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(ox, oy, drawW, drawH);

      // 해상도 라벨
      ctx.fillStyle = "rgba(120,120,120,0.6)";
      ctx.font = "8px monospace";
      ctx.fillText(`${width}×${height}  res: ${resolution}m/cell`, ox + 3, oy + drawH - 4);

      // 로봇 위치 마커
      if (robotX !== undefined && robotY !== undefined) {
        const cellX = (robotX - origin.position.x) / resolution;
        const cellY = (robotY - origin.position.y) / resolution;
        const px = ox + cellX * scale;
        const py = oy + (height - cellY) * scale;

        // 외부 링
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // 본체
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(239,68,68,0.95)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 방향 화살표
        if (robotYaw !== undefined) {
          const len = 13;
          const ax = px + len * Math.cos(robotYaw);
          const ay = py - len * Math.sin(robotYaw); // canvas Y 반전
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(ax, ay);
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }, [mapData, robotX, robotY, robotYaw, size]);

    return <canvas ref={canvasRef} width={size} height={size} className="block" />;
  },
);

MapCanvas.displayName = "MapCanvas";
export default MapCanvas;

// ── 다운로드 헬퍼 (외부 export) ───────────────────────────────────────────────

export function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// nav2 map_saver_cli 호환 PGM 바이너리 생성
export function buildPgmBlob(mapData: OccupancyGridMsg): Blob {
  const { width, height, data } = { ...mapData.info, data: mapData.data };
  const header = new TextEncoder().encode(
    `P5\n# Generated by SLAM Web Dashboard\n${width} ${height}\n255\n`,
  );
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      // 수직 반전 (row 0 = 남쪽 → 파일 row 0 = 상단)
      const srcIdx = (height - 1 - row) * width + col;
      const val = mapData.data[srcIdx] ?? -1;
      pixels[row * width + col] =
        val < 0  ? 205                                              // unknown → grey
        : Math.round((1 - Math.max(0, Math.min(100, val)) / 100) * 254); // free=254, occ=0
    }
  }
  const buf = new Uint8Array(header.length + pixels.length);
  buf.set(header);
  buf.set(pixels, header.length);
  return new Blob([buf], { type: "image/x-portable-graymap" });
}

// nav2 map_server 호환 YAML 생성
export function buildYamlText(mapData: OccupancyGridMsg, pgmFilename: string): string {
  const { resolution, origin } = mapData.info;
  const x = origin.position.x.toFixed(6);
  const y = origin.position.y.toFixed(6);
  return [
    `image: ${pgmFilename}`,
    `resolution: ${resolution}`,
    `origin: [${x}, ${y}, 0.000000]`,
    `negate: 0`,
    `occupied_thresh: 0.65`,
    `free_thresh: 0.196`,
    "",
  ].join("\n");
}
