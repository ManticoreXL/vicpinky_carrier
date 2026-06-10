import { useEffect, useRef, useState } from "react";
import { ROSBRIDGE_URL } from "../config";

export type SubscribeFn = <T>(
  name: string,
  type: string,
  callback: (msg: T) => void
) => ROSLIB.Topic | null;

export type PublishFn = (
  name: string,
  type: string,
  message: Record<string, unknown>
) => void;

export type CallServiceFn = (
  name: string,
  type: string,
  request: Record<string, unknown>,
  callback: (response: Record<string, unknown>) => void
) => void;

export interface PanelProps {
  subscribe: SubscribeFn;
  publish: PublishFn;
}

export function useRos() {
  const rosRef = useRef<ROSLIB.Ros | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!window.ROSLIB) return;

    const ros = new window.ROSLIB.Ros({ url: ROSBRIDGE_URL });
    rosRef.current = ros;

    ros.on("connection", () => {
      setConnected(true);
      setError(null);
    });
    ros.on("error", (e) => {
      setError(e);
      setConnected(false);
    });
    ros.on("close", () => setConnected(false));

    return () => ros.close();
  }, []);

  const subscribe: SubscribeFn = (name, type, callback) => {
    if (!rosRef.current) return null;
    const listener = new window.ROSLIB.Topic({
      ros: rosRef.current,
      name,
      messageType: type,
    });
    listener.subscribe(callback as (msg: Record<string, unknown>) => void);
    return listener;
  };

  const publish: PublishFn = (name, type, message) => {
    if (!rosRef.current) return;
    const publisher = new window.ROSLIB.Topic({
      ros: rosRef.current,
      name,
      messageType: type,
    });
    publisher.publish(new window.ROSLIB.Message(message));
  };

  const callService: CallServiceFn = (name, type, request, callback) => {
    if (!rosRef.current) return;
    const svc = new window.ROSLIB.Service({
      ros: rosRef.current,
      name,
      serviceType: type,
    });
    svc.callService(new window.ROSLIB.ServiceRequest(request), callback);
  };

  return { ros: rosRef.current, connected, error, subscribe, publish, callService };
}
