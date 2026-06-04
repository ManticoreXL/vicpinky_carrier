import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";

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
  actionName: string;   // e.g. "/vicpinky/carrier_task"
  actionType: string;   // e.g. "carrier_msgs/action/CarrierTask"
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
  status: number;       // 3=succeeded 4=aborted 5=canceled
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

export function useNestSocket() {
  const socketRef = useRef<Socket | null>(null);
  const serviceCallbacksRef = useRef<Map<string, (res: unknown) => void>>(new Map());
  const [nestConnected, setNestConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [rosMessages, setRosMessages] = useState<Record<string, RosMessage>>({});

  // Action 상태
  const [activeGoals, setActiveGoals]         = useState<ActiveGoals>({});
  const [actionFeedbacks, setActionFeedbacks] = useState<Record<string, ActionFeedback>>({});
  const [actionResults, setActionResults]     = useState<Record<string, ActionResult>>({});

  // 맵 상태 (raw 데이터 대신 경량 메타만 유지)
  const [mapTimestamps, setMapTimestamps] = useState<MapTimestamps>({});
  const [mapInfos, setMapInfos]           = useState<MapInfos>({});

  useEffect(() => {
    const s = io("http://localhost:3001", {
      transports: ["polling", "websocket"],
    });
    socketRef.current = s;
    setSocket(s);
    const socket = s;

    socket.on("connect",    () => setNestConnected(true));
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
      setMapInfos((prev)     => { const n = { ...prev }; delete n[botId]; return n; });
    });

    socket.on("action_cancelled", ({ goalId }: { goalId: string }) => {
      setActiveGoals((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => { if (next[k] === goalId) delete next[k]; });
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

  return {
    emitCmdVel, emitPublish, emitAction, cancelAction, callService,
    nestConnected, rosMessages, socket,
    activeGoals, actionFeedbacks, actionResults,
    mapTimestamps, mapInfos,
  };
}