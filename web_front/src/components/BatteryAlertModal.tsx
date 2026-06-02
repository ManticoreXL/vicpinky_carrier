import type { BatteryNotification } from "../hooks/useBatteryAlerts";

interface Props {
  notifications: BatteryNotification[];
  onConfirm: (id: string) => void;
}

export default function BatteryAlertModal({ notifications, onConfirm }: Props) {
  if (notifications.length === 0) return null;

  const current = notifications[0];
  const pending = notifications.length - 1;
  const isLow   = current.type === "low";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 오버레이 */}
      <div className="absolute inset-0 bg-black/80" />

      {/* 모달 */}
      <div className={`relative z-10 w-80 border shadow-2xl shadow-black ${
        isLow
          ? "bg-[#0d0000] border-red-800/70"
          : "bg-[#000d00] border-green-900/70"
      }`}>

        {/* 상단 경보 바 */}
        <div className={`px-4 py-2 flex items-center gap-2 border-b ${
          isLow ? "border-red-900/50 bg-red-950/40" : "border-green-900/50 bg-green-950/40"
        }`}>
          <span className={`text-[10px] font-black uppercase tracking-[0.3em] font-mono ${
            isLow ? "text-red-500 danger-pulse" : "text-green-600"
          }`}>
            {isLow ? "⚠ BATTERY CRITICAL" : "◉ CHARGE COMPLETE"}
          </span>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {/* 로봇 ID */}
          <div>
            <p className="text-[9px] text-[#444444] font-mono uppercase tracking-[0.3em] mb-1">NAMESPACE</p>
            <p className="text-sm font-black font-mono text-[#c0c0c0] tracking-widest">{current.robotId}</p>
            <p className="text-[10px] text-[#444444] font-mono">{current.robotLabel}</p>
          </div>

          {/* 배터리 수치 */}
          <div>
            <div className="flex items-end justify-between mb-2">
              <span className="text-[9px] text-[#444444] font-mono uppercase tracking-widest">BATTERY LEVEL</span>
              <span className={`text-3xl font-black font-mono tabular-nums ${
                isLow ? "text-red-500" : "text-green-600"
              }`}>{current.percentage}%</span>
            </div>
            <div className="h-2 bg-[#0a0a0a] border border-[#1e1e1e] overflow-hidden">
              <div
                className={`h-full transition-all ${isLow ? "bg-red-700" : "bg-green-700"}`}
                style={{ width: `${current.percentage}%` }}
              />
            </div>
            <p className={`text-[10px] font-mono mt-2 ${isLow ? "text-red-600/70" : "text-green-700/70"}`}>
              {isLow
                ? "즉시 충전 필요 — 확인 후 10분 재알림"
                : "충전 완료 — 충전기 분리 권장"}
            </p>
          </div>

          {pending > 0 && (
            <p className="text-[9px] text-[#333333] font-mono text-center uppercase tracking-widest">
              + {pending}개 알림 대기 중
            </p>
          )}

          {/* 확인 버튼 */}
          <button
            onClick={() => onConfirm(current.id)}
            className={`w-full py-3 text-xs font-black uppercase tracking-[0.2em] transition-all border ${
              isLow
                ? "border-red-700/70 bg-red-950/40 text-red-400 hover:bg-red-900/60 hover:text-red-300"
                : "border-green-800/60 bg-green-950/30 text-green-500 hover:bg-green-900/40 hover:text-green-400"
            }`}
          >
            {isLow ? "◉ 확인 (10분 후 재알림)" : "◉ 확인"}
          </button>
        </div>
      </div>
    </div>
  );
}
