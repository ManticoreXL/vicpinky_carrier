// 좌표 변환 헬퍼
import type { ViewState } from "./types";

export function worldToCanvas(wx: number, wy: number, v: ViewState): [number, number] {
  const mapPx = (wx - v.info.originX) / v.info.resolution;
  const mapPy = v.info.height - (wy - v.info.originY) / v.info.resolution;
  return [mapPx * v.scale + v.offX, mapPy * v.scale + v.offY];
}

export function canvasToWorld(cx: number, cy: number, v: ViewState): [number, number] {
  const mapPx = (cx - v.offX) / v.scale;
  const mapPy = (cy - v.offY) / v.scale;
  const wx = v.info.originX + mapPx * v.info.resolution;
  const wy = v.info.originY + (v.info.height - mapPy) * v.info.resolution;
  return [wx, wy];
}
