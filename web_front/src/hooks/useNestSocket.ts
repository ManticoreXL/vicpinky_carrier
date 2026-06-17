import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";
import { BACKEND_URL } from "../config";

export interface ServiceCallPayload {
 serviceName: string;
 serviceType: string;
 request: Record<string, unknown>;
}

export interface CmdVelPayload {
 botId: string;
 linear: number;
 angular: number;
}

export interface TopicPublishPayload {
 topicName: string;
 messageType: string;
 message: Record<string, unknown>;
}

export interface RosMessage {
 topic: string;
 data: Record<string, unknown>;
 timestamp: number;
}

export interface ActionGoalPayload {
 actionName: string; // e.g. "/vicpinky/carrier_task"
 actionType: string; // e.g. "carrier_msgs/action/CarrierTask"
 goal: Record<string, unknown>;
}

export interface ActionFeedback {
 goalId: string;
 actionName: string;
 feedback: Record<string, unknown>;
}

export interface ActionResult {
 goalId: string;
 actionName: string;
 result: Record<string, unknown>;
 status: number; // 3=succeeded 4=aborted 5=canceled
}

// actionName → 현재 goalId (진행 중일 때만)
export type ActiveGoals = Record<string, string>;

export interface MapInfo {
 resolution: number;
 width: number;
 height: number;
 origin: { position: { x: number; y: number; z: number } };
}

// botId → 마지막 맵 업데이트 타임스탬프
export type MapTimestamps = Record<string, number>;
// botId → 맵 메타데이터
export type MapInfos = Record<string, MapInfo>;

// ── 로봇 정보 (DB + 실시간 텔레메트리 병합) ──────────────────────────────────
export interface RobotInfo {
  robot_id: string;
  ip: string;
  ros_domain_id: number;
  status: string;
  location?: string | null;
  pose_x?: number | null;
  pose_y?: number | null;
  yaw?: number | null;
  battery?: number | null;
  lastSeenAt?: string | null;
}

// ── FMS 타입 ─────────────────────────────────────────────────────────────────
export type TaskStatus = 'PENDING' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type TaskType = 'SUPPLY' | 'PROCESS' | 'CHARGE' | 'MOVE';

export interface FmsTask {
 _id: string;
 task_id: string;
 type: TaskType;
 status: TaskStatus;
 priority: number;
 targetNode: string;
 preferredRobotId?: string | null;
 waitReason?: string;
 assignedRobotId: string | null;
 pathQueue: string[];
 fullPath?: string[];
 createdAt: string;
 startedAt?: string;
 completedAt?: string;
 result?: Record<string, unknown>;
}

export interface FmsDispatchPayload {
 task_id?: string;
 type: TaskType;
 targetNode: string;
 priority?: number;
 preferredRobotId?: string;
}

export interface TaskManagerAlert {
 id: string;
 type: 'fall' | 'robot_offline' | 'task_failed' | 'assigned' | 'completed' | 'info';
 taskId?: string;
 robotId?: string;
 message: string;
 requiresAction: boolean;
 timestamp: number;
}

export function useNestSocket() {
 const socketRef = useRef<Socket | null>(null);
 const serviceCallbacksRef = useRef<Map<string, (res: unknown) => void>>(new Map());
 const [nestConnected, setNestConnected] = useState(false);
 const [socket, setSocket] = useState<Socket | null>(null);
 const [rosMessages, setRosMessages] = useState<Record<string, RosMessage>>({});

 // Action 상태
 const [activeGoals, setActiveGoals] = useState<ActiveGoals>({});
 const [actionFeedbacks, setActionFeedbacks] = useState<Record<string, ActionFeedback>>({});
 const [actionResults, setActionResults] = useState<Record<string, ActionResult>>({});

 // 맵 상태 (raw 데이터 대신 경량 메타만 유지)
 const [mapTimestamps, setMapTimestamps] = useState<MapTimestamps>({});
 const [mapInfos, setMapInfos] = useState<MapInfos>({});

 // FMS 상태
 const [fmsTasks, setFmsTasks] = useState<FmsTask[]>([]);
 // Task Manager 알림 (최근 50개 유지)
 const [tmAlerts, setTmAlerts] = useState<TaskManagerAlert[]>([]);
 // 로봇별 실시간 상태 (robot_id → status) — 하위 호환 유지
 const [robotStatuses, setRobotStatuses] = useState<Record<string, string>>({});
 // 로봇 목록 (DB + 텔레메트리 통합, 소켓 이벤트로 실시간 갱신)
 const [robots, setRobots] = useState<RobotInfo[]>([]);
 // 잠긴 노드 집합 (node_id)
 const [lockedNodes, setLockedNodes] = useState<Set<string>>(new Set());

 useEffect(() => {
 const s = io(BACKEND_URL, {
 transports: ["polling", "websocket"],
 });
 socketRef.current = s;
 setSocket(s);
 const socket = s;

 socket.on("connect", () => {
 setNestConnected(true);
 socket.emit("fms_get_tasks", { limit: 200 });
 });
 socket.on("disconnect", () => setNestConnected(false));

 socket.on("ros_message", (msg: RosMessage) => {
 setRosMessages((prev) => ({ ...prev, [msg.topic]: msg }));
 });

 socket.on("service_response", ({ service, response }: { service: string; response: unknown }) => {
 const cb = serviceCallbacksRef.current.get(service);
 if (cb) {
 cb(response);
 serviceCallbacksRef.current.delete(service);
 }
 });

 // ── Action 이벤트 ────────────────────────────────────────────────────
 socket.on("action_accepted", ({ goalId, actionName }: { goalId: string; actionName: string }) => {
 setActiveGoals((prev) => ({ ...prev, [actionName]: goalId }));
 // 새 goal이 올 때 이전 결과 초기화
 setActionResults((prev) => {
 const next = { ...prev };
 delete next[goalId];
 return next;
 });
 });

 socket.on("action_feedback", (msg: ActionFeedback) => {
 setActionFeedbacks((prev) => ({ ...prev, [msg.goalId]: msg }));
 });

 socket.on("action_result", (msg: ActionResult) => {
 setActionResults((prev) => ({ ...prev, [msg.goalId]: msg }));
 setActiveGoals((prev) => {
 const next = { ...prev };
 // 해당 action의 active goal 제거
 Object.keys(next).forEach((k) => {
 if (next[k] === msg.goalId) delete next[k];
 });
 return next;
 });
 });

 // ── 맵 이벤트 (경량: raw 데이터 없음) ──────────────────────────────────
 socket.on("map_updated", ({ botId, info, timestamp }: { botId: string; info: MapInfo; timestamp: number }) => {
 setMapTimestamps((prev) => ({ ...prev, [botId]: timestamp }));
 if (info) setMapInfos((prev) => ({ ...prev, [botId]: info }));
 });

 socket.on("map_cleared", ({ botId }: { botId: string }) => {
 setMapTimestamps((prev) => { const n = { ...prev }; delete n[botId]; return n; });
 setMapInfos((prev) => { const n = { ...prev }; delete n[botId]; return n; });
 });

 socket.on("action_cancelled", ({ goalId }: { goalId: string }) => {
 setActiveGoals((prev) => {
 const next = { ...prev };
 Object.keys(next).forEach((k) => { if (next[k] === goalId) delete next[k]; });
 return next;
 });
 });

 // ── FMS 이벤트 ──────────────────────────────────────────────────────────
 socket.on("fms_tasks", (tasks: FmsTask[]) => {
 setFmsTasks(tasks);
 });

 socket.on("fms_task_created", (task: FmsTask) => {
 setFmsTasks((prev) => [task, ...prev].slice(0, 200));
 });

 socket.on("fms_task_updated", (patch: Partial<FmsTask> & { _id: string }) => {
 setFmsTasks((prev) =>
 prev.map((t) => (t._id === patch._id ? { ...t, ...patch } : t)),
 );
 });

 // ── Task Manager 알림 ───────────────────────────────────────────────────
 socket.on("task_manager_alert", (alert: TaskManagerAlert) => {
 setTmAlerts((prev) => [alert, ...prev].slice(0, 50));
 });

 // ── 로봇 목록 초기 전송 (연결 즉시) ────────────────────────────────────
 socket.on("robots_init", (list: RobotInfo[]) => {
 setRobots(list);
 // robotStatuses 동기화 (기존 코드 하위 호환)
 const statusMap: Record<string, string> = {};
 list.forEach(r => { statusMap[r.robot_id] = r.status; });
 setRobotStatuses(prev => ({ ...prev, ...statusMap }));
 });

 // ── 신규/복귀 로봇 (upsert) ─────────────────────────────────────────────
 socket.on("robot_registered", (robot: RobotInfo) => {
 setRobots(prev => {
  const idx = prev.findIndex(r => r.robot_id === robot.robot_id);
  if (idx >= 0) {
  const next = [...prev];
  next[idx] = { ...next[idx], ...robot };
  return next;
  }
  return [...prev, robot];
 });
 setRobotStatuses(prev => ({ ...prev, [robot.robot_id]: robot.status }));
 });

 // ── 로봇 상태 자동 변경 알림 ────────────────────────────────────────────
 socket.on("robot_status_changed", (payload: { robot_id: string; status: string }) => {
 setRobotStatuses(prev => ({ ...prev, [payload.robot_id]: payload.status }));
 setRobots(prev =>
  prev.map(r => r.robot_id === payload.robot_id ? { ...r, status: payload.status } : r)
 );
 });

 // ── 실시간 텔레메트리 (배터리·위치 즉시 반영) ────────────────────────────
 socket.on("robot_telemetry", (tel: {
  robotId: string; posX: number | null; posY: number | null;
  yaw: number | null; battery: number | null; lastSeen: number;
 }) => {
 setRobots(prev =>
  prev.map(r => r.robot_id === tel.robotId
  ? { ...r, pose_x: tel.posX, pose_y: tel.posY, yaw: tel.yaw, battery: tel.battery }
  : r
  )
 );
 });

 // ── 노드 잠금 초기 상태 (연결 시 서버 DB 기준으로 동기화) ──────────────
 socket.on("node_lock_init", (nodeIds: string[]) => {
 setLockedNodes(new Set(nodeIds));
 });

 // ── 노드 잠금 실시간 변경 ───────────────────────────────────────────────
 socket.on("node_lock_changed", ({ node_id, isLocked }: { node_id: string; isLocked: boolean }) => {
 setLockedNodes(prev => {
 const next = new Set(prev);
 isLocked ? next.add(node_id) : next.delete(node_id);
 return next;
 });
 });

 return () => { s.disconnect(); setSocket(null); };
 }, []);

 const emitCmdVel = useCallback((payload: CmdVelPayload) => {
 socketRef.current?.emit("cmd_vel", payload);
 }, []);

 const emitPublish = useCallback((payload: TopicPublishPayload) => {
 socketRef.current?.emit("publish", payload);
 }, []);

 const emitAction = useCallback((payload: ActionGoalPayload) => {
 socketRef.current?.emit("send_action", payload);
 }, []);

 const cancelAction = useCallback((actionName: string, goalId: string) => {
 socketRef.current?.emit("cancel_action", { actionName, goalId });
 }, []);

 const callService = useCallback((
 serviceName: string,
 serviceType: string,
 request: Record<string, unknown>,
 callback: (res: unknown) => void,
 ) => {
 serviceCallbacksRef.current.set(serviceName, callback);
 socketRef.current?.emit("call_service", { serviceName, serviceType, request });
 }, []);

 const emitNodeLock = useCallback((nodeId: string, isLocked: boolean) => {
 socketRef.current?.emit("node_lock", { nodeId, isLocked });
 }, []);

 const emitFmsDispatch = useCallback((payload: FmsDispatchPayload) => {
 socketRef.current?.emit("fms_dispatch_task", payload);
 }, []);

 const emitFmsCancel = useCallback((taskId: string) => {
 socketRef.current?.emit("fms_cancel_task", { taskId });
 }, []);

 const emitNavInitialPose = useCallback((robotId: string, x: number, y: number, yaw: number, mapId?: string) => {
 socketRef.current?.emit("nav_set_initialpose", { robotId, x, y, yaw, mapId });
 }, []);

 const ackTmAlert = useCallback((alertId: string) => {
 socketRef.current?.emit("task_manager_ack", { alertId });
 setTmAlerts((prev) => prev.filter((a) => a.id !== alertId));
 }, []);

 const setRobotHome = useCallback((robotId: string, x: number, y: number, yaw: number) => {
 socketRef.current?.emit("task_manager_set_home", { robotId, x, y, yaw });
 }, []);

 return {
 emitCmdVel, emitPublish, emitAction, cancelAction, callService,
 emitFmsDispatch, emitFmsCancel, emitNodeLock,
 emitNavInitialPose,
 ackTmAlert, setRobotHome,
 nestConnected, rosMessages, socket,
 activeGoals, actionFeedbacks, actionResults,
 mapTimestamps, mapInfos,
 fmsTasks, tmAlerts,
 robots, robotStatuses, lockedNodes,
 };
}