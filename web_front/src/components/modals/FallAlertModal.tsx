import type { TaskManagerAlert } from "../../hooks/useNestSocket";

interface Props {
 alerts: TaskManagerAlert[];
 onConfirm: (id: string) => void;
}

// 로봇 ID → 한글 라벨 매핑
const ROBOT_LABELS: Record<string, string> = {
 tb3_01: "터틀봇 1 (UNIT-ALPHA)",
 tb3_02: "터틀봇 2 (UNIT-BRAVO)",
 tb3_03: "터틀봇 3 (UNIT-CHARLIE)",
 tb3_04: "터틀봇 4 (UNIT-DELTA)",
 vicpinky: "VIC-PINKY",
 omx: "OMX-ARM",
};

export default function FallAlertModal({ alerts, onConfirm }: Props) {
 const fallAlerts = alerts.filter(a => a.type === "fall");
 if (fallAlerts.length === 0) return null;

 const current = fallAlerts[0];
 const pending = fallAlerts.length - 1;
 const robotLabel = current.robotId ? (ROBOT_LABELS[current.robotId] ?? current.robotId) : "알 수 없음";

 return (
  <div className="fixed inset-0 z-[60] flex items-center justify-center">
   {/* 오버레이 */}
   <div className="absolute inset-0 bg-[#521C0D]/30 backdrop-blur-sm" />

   {/* 모달 */}
   <div className="relative z-10 w-80 glass-panel shadow-2xl border-white/[0.1]">

    {/* 상단 경보 바 */}
    <div className="px-5 py-3 flex items-center gap-3 border-b border-white/[0.1] bg-rose-500/15">
     <div className="w-2 h-2 rounded-full bg-rose-400 animate-ping absolute" />
     <div className="w-2 h-2 rounded-full bg-rose-500" />
     <span className="text-xs font-semibold tracking-wide text-rose-800">
      ROBOT OVERTURN DETECTED
     </span>
    </div>

    <div className="p-6 flex flex-col gap-5">
     {/* 로봇 정보 */}
     <div>
      <span className="sub-label">UNIT</span>
      <p className="text-lg font-semibold text-white/90 tracking-wide">
       {current.robotId ?? "—"}
      </p>
      <p className="text-xs text-white/[0.6] mt-1">{robotLabel}</p>
     </div>

     {/* 경고 메시지 */}
     <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20">
      <div className="flex items-start gap-3">
       <span className="text-xl leading-none mt-0.5">⚠️</span>
       <div>
        <p className="text-xs font-semibold text-rose-800 mb-1">전복 감지</p>
        <p className="text-xs text-white/[0.68] leading-relaxed">{current.message}</p>
       </div>
      </div>
     </div>

     {/* 안내 */}
     <p className="text-xs text-white/[0.55] leading-relaxed">
      로봇이 전복되었습니다. 즉시 현장을 확인하고 로봇을 안전하게 복구하세요.
      태스크가 자동으로 중단될 수 있습니다.
     </p>

     {pending > 0 && (
      <div className="py-2 bg-[#FFCE99]/32 border border-white/[0.1] rounded-lg">
       <p className="text-xs text-white/[0.55] text-center tracking-wide">
        + {pending}개 추가 알림 대기 중
       </p>
      </div>
     )}

     {/* 확인 버튼 */}
     <button
      onClick={() => onConfirm(current.id)}
      className="w-full py-4 text-xs font-semibold tracking-wide transition-all duration-300 rounded-xl border border-white/[0.1] bg-rose-500/20 text-white/[0.82] hover:bg-rose-500/40 hover:text-white"
     >
      확인 (Acknowledge)
     </button>
    </div>
   </div>
  </div>
 );
}
