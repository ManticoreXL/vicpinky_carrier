import { useEffect, useRef, useCallback } from "react";

interface CmdVelPayload {
  botId: string;
  linear: number;
  angular: number;
}

interface Props {
  botId: string;
  enabled: boolean;
  publish: (payload: CmdVelPayload) => void;
  linearSpeed?: number;
  angularSpeed?: number;
}

const KEY_MAP: Record<string, { linear: number; angular: number }> = {
  w:          { linear:  1.0, angular:  0.0 },
  s:          { linear: -1.0, angular:  0.0 },
  a:          { linear:  0.0, angular:  1.0 },
  d:          { linear:  0.0, angular: -1.0 },
  ArrowUp:    { linear:  1.0, angular:  0.0 },
  ArrowDown:  { linear: -1.0, angular:  0.0 },
  ArrowLeft:  { linear:  0.0, angular:  1.0 },
  ArrowRight: { linear:  0.0, angular: -1.0 },
};

export function useKeyboardControl({
  botId,
  enabled,
  publish,
  linearSpeed = 0.2,
  angularSpeed = 1.0,
}: Props) {
  const pressedKeys = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendVel = useCallback(() => {
    let linear = 0;
    let angular = 0;

    pressedKeys.current.forEach((key) => {
      const v = KEY_MAP[key];
      if (v) {
        linear  += v.linear  * linearSpeed;
        angular += v.angular * angularSpeed;
      }
    });

    // 클램프
    linear  = Math.max(-linearSpeed,  Math.min(linearSpeed,  linear));
    angular = Math.max(-angularSpeed, Math.min(angularSpeed, angular));

    publish({ botId, linear, angular });
  }, [botId, publish, linearSpeed, angularSpeed]);

  useEffect(() => {
    if (!enabled) {
      // 비활성화 시 정지 명령 한 번 전송
      publish({ botId, linear: 0, angular: 0 });
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (KEY_MAP[e.key]) {
        e.preventDefault();
        pressedKeys.current.add(e.key);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      pressedKeys.current.delete(e.key);
      // 모든 키 뗐을 때 정지
      if (pressedKeys.current.size === 0) {
        publish({ botId, linear: 0, angular: 0 });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // 100ms 마다 현재 눌린 키 기반으로 cmd_vel 발행
    intervalRef.current = setInterval(sendVel, 100);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (intervalRef.current) clearInterval(intervalRef.current);
      pressedKeys.current.clear();
    };
  }, [enabled, sendVel, botId, publish]);
}