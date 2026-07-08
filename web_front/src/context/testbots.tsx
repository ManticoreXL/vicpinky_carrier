import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

// 운영 화면(플릿/태스크)에서 가상 테스트봇(TEST-BOT*) 표시 여부 토글.
// 도메인 상태가 아니라 "보이기/숨기기" 화면 설정이므로 프론트 로컬(localStorage)에 둔다.
// 기본값 false — 기존 동작(운영 화면에서 테스트봇 숨김)과 동일.
const KEY = "fms.showTestBots";

interface TestBotsCtx {
  showTestBots: boolean;
  toggle: () => void;
}

const Ctx = createContext<TestBotsCtx>({ showTestBots: false, toggle: () => {} });

export function TestBotsProvider({ children }: { children: ReactNode }) {
  const [showTestBots, setShow] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setShow((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return <Ctx.Provider value={{ showTestBots, toggle }}>{children}</Ctx.Provider>;
}

export const useTestBots = (): TestBotsCtx => useContext(Ctx);
