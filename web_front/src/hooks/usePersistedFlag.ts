import { useCallback, useState } from "react";

// localStorage에 저장되는 on/off 플래그 훅.
// 여러 컴포넌트가 같은 key를 쓰면 하나의 토글처럼 동작하고(어디서 켜든 값 공유),
// 새로고침·패널 전환에도 유지된다. (표시/숨김 같은 보기 설정용)
export function usePersistedFlag(key: string, initial = false): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : v === "1";
    } catch {
      return initial;
    }
  });

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* 무시 */ }
      return next;
    });
  }, [key]);

  return [on, toggle];
}
