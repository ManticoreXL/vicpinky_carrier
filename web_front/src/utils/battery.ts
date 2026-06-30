// 배터리 % 표준화/검증 (표시용) — battery_state.percentage(0~1 또는 0~100)를 0~100으로 정규화하고,
//  - 음수/큰 garbage(예: -21344) = 센서 글리치 → null("—"로 표시)
//  - 100~110 약간 초과(예: 110) → 100으로 클램프
//  - null/undefined → null
// (백엔드 web_back/src/common/battery.ts normalizeBatteryPct 와 동일 규칙, 표시용이라 반올림까지.)
export function batteryPercent(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  const v = raw <= 1.01 ? raw * 100 : raw;
  if (v < 0 || v > 110) return null;
  return Math.round(v > 100 ? 100 : v);
}
