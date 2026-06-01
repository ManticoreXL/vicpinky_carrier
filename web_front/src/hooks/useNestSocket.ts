import { useEffect, useRef, useCallback, useState } from "react";
import { io, Socket } from "socket.io-client";

const NEST_URL = "http://localhost:3001/ros";

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

export function useNestSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [nestConnected, setNestConnected] = useState(false);
  // topic → 최신 메시지 맵
  const [rosMessages, setRosMessages] = useState<Record<string, RosMessage>>({});

  useEffect(() => {
    const socket = io(NEST_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => setNestConnected(true));
    socket.on("disconnect", () => setNestConnected(false));

    // NestJS가 브로드캐스트하는 모든 ROS 메시지 수신
    socket.on("ros_message", (msg: RosMessage) => {
      setRosMessages((prev) => ({ ...prev, [msg.topic]: msg }));
    });

    return () => { socket.disconnect(); };
  }, []);

  // cmd_vel → NestJS → rosbridge → 터틀봇
  const emitCmdVel = useCallback((payload: CmdVelPayload) => {
    socketRef.current?.emit("cmd_vel", payload);
  }, []);

  // 일반 토픽 발행 → NestJS → rosbridge
  const emitPublish = useCallback((payload: TopicPublishPayload) => {
    socketRef.current?.emit("publish", payload);
  }, []);

  return { emitCmdVel, emitPublish, nestConnected, rosMessages };
}