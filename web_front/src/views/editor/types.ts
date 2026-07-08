// TopologyEditor 전용 타입

export interface MapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  snapThreshold?: number;
}

export interface FNode {
  node_id: string;
  map_id: string;
  type: "WAYPOINT" | "STATION" | "CHARGER" | "VICTIM";
  x: number;
  y: number;
  yaw: number;
}

export interface FEdge {
  edge_id: string;
  map_id: string;
  startNode: string;
  endNode: string;
  direction: "ONE_WAY" | "BOTH_WAY";
  isLocked: boolean;
  weight?: number;
}

export type Mode = "select" | "node" | "edge";

export interface ViewState {
  scale: number;
  offX: number;
  offY: number;
  info: MapInfo;
}
