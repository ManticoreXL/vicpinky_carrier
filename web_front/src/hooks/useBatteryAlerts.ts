import { useState, useEffect, useRef, useCallback } from "react";
import type { RosMessage } from "./useNestSocket";

// ── 상수 ──────────────────────────────────────────────────────────────────────

const LOW_THRESHOLD       = 15;               // % 이하 → 경고
const FULL_THRESHOLD      = 95;               // % 이상 → 완충
const FULL_RESET_BELOW    = 90;               // % 미만으로 떨어지면 완충 알림 초기화
const SNOOZE_MS           = 10 * 60 * 1000;  // 10분

const ALL_ROBOTS = ["bigpinky", "tb3_01", "tb3_02", "tb3_03", "tb3_04"] as const;

export const ROBOT_LABELS: Record<string, string> = {
  bigpinky: "빅핑키",
  tb3_01:   "터틀봇 1 (tb3_01)",
  tb3_02:   "터틀봇 2 (tb3_02)",
  tb3_03:   "터틀봇 3 (tb3_03)",
  tb3_04:   "터틀봇 4 (tb3_04)",
};

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface BatteryNotification {
  id: string;
  robotId: string;
  robotLabel: string;
  type: "low" | "full";
  percentage: number;
  createdAt: number;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function getBatteryPct(
  robotId: string,
  rosMessages: Record<string, RosMessage>,
): number | null {
  const topic =
    robotId === "bigpinky" ? "/bigpinky/battery" : `/${robotId}/battery_state`;
  const data = rosMessages[topic]?.data as { percentage?: number } | undefined;
  if (data?.percentage == null) return null;
  // TB3 펌웨어는 0~100, 일부 장치는 0~1 — 양쪽 대응
  return data.percentage > 1 ? data.percentage : data.percentage * 100;
}

let idCounter = 0;
function makeId(prefix: string) {
  return `${prefix}_${++idCounter}`;
}

// ── 훅 ───────────────────────────────────────────────────────────────────────

export function useBatteryAlerts(rosMessages: Record<string, RosMessage>) {
  const [notifications, setNotifications] = useState<BatteryNotification[]>([]);

  // Refs — 렌더 사이클과 무관하게 상태 유지
  const lowAlerted  = useRef<Record<string, boolean>>({});  // 현재 저배터리 알림 추가됨
  const lowSnooze   = useRef<Record<string, number>>({});   // 스누즈 만료 타임스탬프
  const fullAlerted = useRef<Record<string, boolean>>({});  // 현재 완충 알림 추가됨
  const fullAcked   = useRef<Record<string, boolean>>({});  // 사용자가 완충 확인함

  useEffect(() => {
    ALL_ROBOTS.forEach((robotId) => {
      const pct = getBatteryPct(robotId, rosMessages);
      if (pct == null) return;

      const label = ROBOT_LABELS[robotId] ?? robotId;

      // ── 저배터리 (≤15%) ────────────────────────────────────────────────
      if (pct <= LOW_THRESHOLD) {
        const snoozeExpiry = lowSnooze.current[robotId] ?? 0;
        const isSnoozed    = Date.now() < snoozeExpiry;

        if (!isSnoozed && !lowAlerted.current[robotId]) {
          const notif: BatteryNotification = {
            id: makeId(`low_${robotId}`),
            robotId,
            robotLabel: label,
            type: "low",
            percentage: Math.round(pct),
            createdAt: Date.now(),
          };
          lowAlerted.current[robotId] = true;
          setNotifications((prev) => {
            if (prev.some((n) => n.robotId === robotId && n.type === "low")) return prev;
            return [...prev, notif];
          });
        }
      } else {
        // 배터리 회복 → 저배터리 상태 초기화
        lowAlerted.current[robotId] = false;
        lowSnooze.current[robotId]  = 0;
      }

      // ── 완충 (≥95%) ────────────────────────────────────────────────────
      if (pct >= FULL_THRESHOLD) {
        if (!fullAcked.current[robotId] && !fullAlerted.current[robotId]) {
          const notif: BatteryNotification = {
            id: makeId(`full_${robotId}`),
            robotId,
            robotLabel: label,
            type: "full",
            percentage: Math.round(pct),
            createdAt: Date.now(),
          };
          fullAlerted.current[robotId] = true;
          setNotifications((prev) => {
            if (prev.some((n) => n.robotId === robotId && n.type === "full")) return prev;
            return [...prev, notif];
          });
        }
      } else if (pct < FULL_RESET_BELOW) {
        // 배터리가 90% 미만으로 떨어지면 완충 추적 초기화 → 다음 완충 시 재알림
        fullAlerted.current[robotId] = false;
        fullAcked.current[robotId]   = false;
      }
    });
  }, [rosMessages]);

  // ── 확인 핸들러 ──────────────────────────────────────────────────────────
  const confirmNotification = useCallback((notifId: string) => {
    setNotifications((prev) => {
      const notif = prev.find((n) => n.id === notifId);
      if (!notif) return prev;

      if (notif.type === "low") {
        // 10분 스누즈, 이후 배터리가 여전히 낮으면 재알림
        lowSnooze.current[notif.robotId]  = Date.now() + SNOOZE_MS;
        lowAlerted.current[notif.robotId] = false;
      } else {
        // 완충 확인 → 배터리 드롭 전까지 재알림 없음
        fullAcked.current[notif.robotId]   = true;
        fullAlerted.current[notif.robotId] = false;
      }

      return prev.filter((n) => n.id !== notifId);
    });
  }, []);

  // 긴급도 순 정렬: 저배터리 → 완충
  const sorted = [...notifications].sort((a, b) => {
    if (a.type === "low" && b.type !== "low") return -1;
    if (a.type !== "low" && b.type === "low") return 1;
    return a.createdAt - b.createdAt;
  });

  return { notifications: sorted, confirmNotification };
}
