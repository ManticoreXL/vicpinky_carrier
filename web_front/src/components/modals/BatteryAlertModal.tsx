import type { BatteryNotification } from "../../hooks/useBatteryAlerts";

interface Props {
 notifications: BatteryNotification[];
 onConfirm: (id: string) => void;
}

export default function BatteryAlertModal({ notifications, onConfirm }: Props) {
 if (notifications.length === 0) return null;

 const current = notifications[0];
 const pending = notifications.length - 1;
 const isLow = current.type === "low";

 return (
 <div className="fixed inset-0 z-50 flex items-center justify-center">
 {/* 오버레이 */}
 <div className="absolute inset-0 bg-[#521C0D]/30 backdrop-blur-sm" />

 {/* 모달 */}
 <div className={`relative z-10 w-80 glass-panel shadow-2xl ${
 isLow
 ? "border-white/[0.1] "
 : "border-white/[0.1] "
 }`}>

 {/* 상단 경보 바 */}
 <div className={`px-5 py-3 flex items-center gap-3 border-b ${
 isLow ? "border-white/[0.1] bg-rose-500/10" : "border-white/[0.1] bg-emerald-500/10"
 }`}>
 <div className={`w-2 h-2 rounded-full animate-pulse ${isLow ? "bg-rose-500 " : "bg-emerald-500 "}`} />
 <span className={`text-xs font-semibold tracking-wide ${
 isLow ? "text-white/90" : "text-white/90"
 }`}>
 {isLow ? "BATTERY CRITICAL" : "CHARGE COMPLETE"}
 </span>
 </div>

 <div className="p-6 flex flex-col gap-6">
 {/* 로봇 ID */}
 <div>
 <span className="sub-label">NAMESPACE</span>
 <p className="text-lg font-semibold text-white/90 tracking-wide">{current.robotId}</p>
 <p className="text-xs text-white/[0.6] mt-1">{current.robotLabel}</p>
 </div>

 {/* 배터리 수치 */}
 <div>
 <div className="flex items-end justify-between mb-3">
 <span className="sub-label !mb-0">BATTERY LEVEL</span>
 <span className={`text-4xl font-semibold tabular-nums ${
 isLow ? "text-white/90" : "text-white/90"
 }`}>{current.percentage}%</span>
 </div>
 <div className="h-2 bg-[#FFCE99]/32 border border-white/[0.1] rounded-full overflow-hidden">
 <div
 className={`h-full transition-all duration-1000 ${isLow ? "bg-rose-500" : "bg-emerald-500"}`}
 style={{ width: `${current.percentage}%` }}
 />
 </div>
 <p className={`text-xs mt-3 text-white/[0.6] leading-relaxed`}>
 {isLow
 ? "Immediate charge required. Alert will re-arm in 10 mins."
 : "Charging complete. Recommend disconnecting power source."}
 </p>
 </div>

 {pending > 0 && (
 <div className="py-2 bg-[#FFCE99]/32 border border-white/[0.1] rounded-lg">
 <p className="text-xs text-white/[0.55] text-center tracking-wide">
 + {pending} Pending Alerts
 </p>
 </div>
 )}

 {/* 확인 버튼 */}
 <button
 onClick={() => onConfirm(current.id)}
 className={`w-full py-4 text-xs font-semibold tracking-wide transition-all duration-300 rounded-xl border ${
 isLow
 ? "border-white/[0.1] bg-rose-500/20 text-white/[0.82] hover:bg-rose-500/40 hover:text-white"
 : "border-white/[0.1] bg-emerald-500/20 text-white/[0.82] hover:bg-emerald-500/40 hover:text-white"
 }`}
 >
 {isLow ? "Acknowledge (10m Snooze)" : "Acknowledge"}
 </button>
 </div>
 </div>
 </div>
 );
}
