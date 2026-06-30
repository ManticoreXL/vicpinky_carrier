// 배터리 % 공용 유틸 — ROS battery_state는 펌웨어에 따라 0~1 또는 0~100으로 온다. 표준화/검증을 한곳에서.
// (이전에 robot-monitor·telemetry·charging 에 흩어져 중복돼 있던 로직.)

/**
 * 0~1 정규화 값이면 ×100 해서 %로 변환, 이미 %(>1)면 그대로. + 범위 검증.
 *  - 음수/큰 garbage(예: -21344) = 센서 글리치 → null(무효, 캐시·DB·표시에 안 씀)
 *  - 100~110 약간 초과(예: 110) → 100으로 클램프
 *  - null 입력 → null
 */
export function normalizeBatteryPct(pct: number | null | undefined): number | null {
  if (pct == null) return null;
  const v = pct <= 1.01 ? pct * 100 : pct;
  if (v < 0 || v > 110) return null;  // 범위 밖 = 글리치 무효
  return v > 100 ? 100 : v;            // 약간 초과는 100으로
}

/** 0~100 범위면 그 값, 아니면 null. */
export function validBatteryPct(v: number | null | undefined): number | null {
  return v != null && v >= 0 && v <= 100 ? v : null;
}
