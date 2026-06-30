// AdminView 공용 타입

export type RobotStatus =
  | "IDLE" | "RETURNING" | "PAUSED" | "ERROR" | "OFFLINE"
  | "WORKING" | "TO_CHARGE" | "CHARGING" | "WAITING_CHARGE"
  | "PARKED" | "TO_LOAD" | "LOADING" | "LOADED" | "UNLOADING" | "CARRIER_UP" | "CARRIER_DOWN";
export type NodeType = "WAYPOINT" | "STATION" | "CHARGER";
export type EdgeDirection = "ONE_WAY" | "BOTH_WAY";
export type TaskType = "SUPPLY" | "PROCESS" | "CHARGE" | "MOVE";
export type TaskStatus = "DRAFT" | "PENDING" | "ASSIGNED" | "RUNNING" | "SUSPENDED" | "COMPLETED" | "FAILED";

export interface Robot {
  robot_id: string;
  ip: string;
  ros_domain_id: number;
  status: RobotStatus;
  location: string | null;   // 현재 로봇이 위치한 맵 id
  lastNode: string | null;  // 현재/마지막으로 위치한 노드 id
  pose_x: number | null;
  pose_y: number | null;
}

export interface FleetMap {
  map_id: string;
  init_position: Record<string, { x: number; y: number; yaw: number }>;
}

export interface FleetNode {
  node_id: string;
  map_id: string;
  type: NodeType;
  x: number;
  y: number;
  yaw: number;
  /** 맵의 초기 위치(스폰/초기 pose 기준점) 노드 여부 */
  initPosition?: boolean;
  isLocked?: boolean;
  /** 충전소 점유 로봇 ID (CHARGER 노드 한정) — 점유 중이면 robot_id, 아니면 null */
  isLockedBy?: string | null;
}

export interface FleetEdge {
  edge_id: string;
  map_id: string;
  startNode: string;
  endNode: string;
  direction: EdgeDirection;
  isLocked: boolean;
  weight?: number;
}

export interface Task {
  _id: string;
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  targetNode: string;
  waitReason?: string;
  assignedRobotId: string | null;
  createdAt: string;
}
