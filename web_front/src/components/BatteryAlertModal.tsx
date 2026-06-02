import type { BatteryNotification } from "../hooks/useBatteryAlerts";

interface Props {
  notifications: BatteryNotification[];
  onConfirm: (id: string) => void;
}

export default function BatteryAlertModal({ notifications, onConfirm }: Props) {
  if (notifications.length === 0) return null;

  const current  = notifications[0]; // 이미 긴급도 순 정렬됨
  const pending  = notifications.length - 1;
  const isLow    = current.type === "low";

  const pct      = current.percentage;
  const barColor = isLow ? "bg-red-500" : "bg-green-500";
  const borderC  = isLow ? "border-red-700/70" : "border-green-700/70";
  const bgC      = isLow ? "bg-[#180808]"       : "bg-[#081808]";
  const shadowC  = isLow ? "shadow-red-950/60"  : "shadow-green-950/60";
  const textC    = isLow ? "text-red-300"        : "text-green-300";
  const subC     = isLow ? "text-red-400/60"     : "text-green-400/60";
  const innerBg  = isLow ? "bg-red-950/40 border-red-800/30"
                          : "bg-green-950/40 border-green-800/30";
  const btnC     = isLow ? "bg-red-700 hover:bg-red-600 shadow-red-900/40"
                          : "bg-green-700 hover:bg-green-600 shadow-green-900/40";

  return (
    /* 반투명 오버레이 */
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* 모달 카드 */}
      <div className={`
        relative z-10 w-80 rounded-2xl p-6 border shadow-2xl
        ${bgC} ${borderC} ${shadowC}
      `}>

        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl shrink-0 ${
            isLow ? "bg-red-900/60" : "bg-green-900/60"
          }`}>
            {isLow ? "🪫" : "⚡"}
          </div>
          <div>
            <p className={`text-base font-black tracking-wide ${textC}`}>
              {isLow ? "배터리 부족 경고" : "충전 완료"}
            </p>
            <p className="text-xs text-slate-500 font-mono mt-0.5">
              {current.robotLabel}
            </p>
          </div>
        </div>

        {/* 배터리 상태 박스 */}
        <div className={`rounded-xl px-4 py-3 mb-4 border ${innerBg}`}>
          {/* 네임스페이스 + 수치 */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">namespace</p>
              <p className="text-xs font-mono font-bold text-slate-300">{current.robotId}</p>
            </div>
            <span className={`text-3xl font-black font-mono tabular-nums ${
              isLow ? "text-red-400" : "text-green-400"
            }`}>
              {pct}%
            </span>
          </div>

          {/* 배터리 바 */}
          <div className="h-3 bg-slate-800/80 rounded-full overflow-hidden border border-slate-700/30 mb-2">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* 설명 */}
          <p className={`text-xs ${subC}`}>
            {isLow
              ? `잔량 ${pct}% — 즉시 충전이 필요합니다.\n확인 후 10분 뒤 재알림됩니다.`
              : `${pct}% 완충 — 충전기를 분리해 주세요.`}
          </p>
        </div>

        {/* 대기 중 알림 */}
        {pending > 0 && (
          <p className="text-[11px] text-slate-600 text-center mb-3">
            이 외 {pending}개 알림 대기 중
          </p>
        )}

        {/* 확인 버튼 */}
        <button
          onClick={() => onConfirm(current.id)}
          className={`
            w-full py-3 rounded-xl font-bold text-sm text-white
            transition-all shadow-lg active:scale-95
            ${btnC}
          `}
        >
          {isLow ? "확인 (10분 후 재알림)" : "확인"}
        </button>

        {/* 저배터리 스누즈 안내 */}
        {isLow && (
          <p className="text-[10px] text-slate-700 text-center mt-2">
            배터리가 회복되면 자동으로 알림이 초기화됩니다
          </p>
        )}
      </div>
    </div>
  );
}
