// AdminView 공용 타입

export type RobotStatus = "IDLE" | "MOVING" | "WORKING" | "ERROR" | "OFFLINE";
export type NodeType = "WAYPOINT" | "STATION" | "CHARGER";
export type EdgeDirection = "ONE_WAY" | "BOTH_WAY";
export type TaskType = "SUPPLY" | "PROCESS" | "CHARGE" | "MOVE";
export type TaskStatus = "PENDING" | "ASSIGNED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface Robot {
  robot_id: string;
  ip: string;
  ros_domain_id: number;
  status: RobotStatus;
  location: string | null;
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
  isLocked?: boolean;
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
