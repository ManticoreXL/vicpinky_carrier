import { useState, useEffect, useRef } from "react";

/**
 * 값의 최신본을 ref로 추적하고 intervalMs마다 표시 상태를 갱신한다.
 * 데이터 수신은 원본 그대로 유지되므로 알림·로직에는 영향 없음.
 */
export function useThrottled<T>(value: T, intervalMs = 1000): T {
  const [display, setDisplay] = useState<T>(value);
  const latest = useRef<T>(value);

  latest.current = value;

  useEffect(() => {
    const id = setInterval(() => {
      setDisplay(latest.current);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return display;
}
