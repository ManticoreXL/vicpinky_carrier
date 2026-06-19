// NavMapCanvas 전용 타입

export interface StaticMapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  snapThreshold?: number;
}

export interface DragState {
  sx: number; sy: number;
  cx: number; cy: number;
  type: "goal" | "pose" | "home";
}
