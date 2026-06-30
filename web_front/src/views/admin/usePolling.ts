import { useEffect, useRef } from "react";

/**
 * active일 때 ms 간격으로 fn을 호출(폴링)한다. 관리 탭이 항상 DB에서 받아와 새로 그리도록.
 * 편집/추가 중에는 active=false를 주어 폴링을 멈춰 입력 폼이 덮어써지지 않게 한다.
 * (마운트 시 최초 1회 로드는 호출부의 useEffect(load)가 담당 — 탭 전환 = 재마운트 = 즉시 재조회)
 */
export function usePolling(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
