import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";

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
  actionName: string;   // e.g. "/bigpinky/carrier_task"
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

export function useNestSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [nestConnected, setNestConnected] = useState(false);
  const [rosMessages, setRosMessages] = useState<Record<string, RosMessage>>({});

  // Action 상태
  const [activeGoals, setActiveGoals]       = useState<ActiveGoals>({});
  const [actionFeedbacks, setActionFeedbacks] = useState<Record<string, ActionFeedback>>({});
  const [actionResults, setActionResults]   = useState<Record<string, ActionResult>>({});

  useEffect(() => {
    const socket = io("http://localhost:3001", {
      transports: ["polling", "websocket"],
    });
    socketRef.current = socket;

    socket.on("connect",    () => setNestConnected(true));
    socket.on("disconnect", () => setNestConnected(false));

    socket.on("ros_message", (msg: RosMessage) => {
      setRosMessages((prev) => ({ ...prev, [msg.topic]: msg }));
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

    socket.on("action_cancelled", ({ goalId }: { goalId: string }) => {
      setActiveGoals((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => { if (next[k] === goalId) delete next[k]; });
        return next;
      });
    });

    return () => { socket.disconnect(); };
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

  return {
    emitCmdVel, emitPublish, emitAction, cancelAction,
    nestConnected, rosMessages,
    activeGoals, actionFeedbacks, actionResults,
  };
}