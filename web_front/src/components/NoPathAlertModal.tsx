import type { TaskManagerAlert } from "../hooks/useNestSocket";

interface Props {
 alerts: TaskManagerAlert[];
 onSwitchManual: (robotId: string | undefined, alertId: string) => void; // 수동제어 전환
 onDismiss: (id: string) => void;                                        // 취소(무시)
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

// 경로 탐색 실패(수행 불가) 시 수동제어 전환을 묻는 모달
export default function NoPathAlertModal({ alerts, onSwitchManual, onDismiss }: Props) {
 const noPathAlerts = alerts.filter(a => a.type === "no_path");
 if (noPathAlerts.length === 0) return null;

 const current = noPathAlerts[0];
 const pending = noPathAlerts.length - 1;
 const robotLabel = current.robotId ? (ROBOT_LABELS[current.robotId] ?? current.robotId) : "알 수 없음";

 return (
  <div className="fixed inset-0 z-[60] flex items-center justify-center">
   {/* 오버레이 */}
   <div className="absolute inset-0 bg-[#521C0D]/30 backdrop-blur-sm" />

   {/* 모달 */}
   <div className="relative z-10 w-80 glass-panel shadow-2xl border-white/[0.1]">

    {/* 상단 경보 바 */}
    <div className="px-5 py-3 flex items-center gap-3 border-b border-white/[0.1] bg-amber-500/15">
     <div className="w-2 h-2 rounded-full bg-amber-400 animate-ping absolute" />
     <div className="w-2 h-2 rounded-full bg-amber-500" />
     <span className="text-xs font-semibold tracking-wide text-amber-800">
      TASK UNREACHABLE
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
     <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
      <div className="flex items-start gap-3">
       <span className="text-xl leading-none mt-0.5">🚧</span>
       <div>
        <p className="text-xs font-semibold text-amber-800 mb-1">수행할 수 없는 상황</p>
        <p className="text-xs text-white/[0.68] leading-relaxed">{current.message}</p>
       </div>
      </div>
     </div>

     {/* 안내 */}
     <p className="text-xs text-white/[0.55] leading-relaxed">
      경로가 막혀 자동 주행으로 목적지에 도달할 수 없습니다. 수동제어로 전환하여
      해당 로봇을 직접(cmd_vel) 조종하시겠습니까?
     </p>

     {pending > 0 && (
      <div className="py-2 bg-[#FFCE99]/32 border border-white/[0.1] rounded-lg">
       <p className="text-xs text-white/[0.55] text-center tracking-wide">
        + {pending}개 추가 알림 대기 중
       </p>
      </div>
     )}

     {/* 버튼 */}
     <div className="flex flex-col gap-2">
      <button
       onClick={() => onSwitchManual(current.robotId, current.id)}
       className="w-full py-4 text-xs font-semibold tracking-wide transition-all duration-300 rounded-xl border border-amber-500/30 bg-amber-500/25 text-white/[0.85] hover:bg-amber-500/45 hover:text-white"
      >
       수동제어로 전환
      </button>
      <button
       onClick={() => onDismiss(current.id)}
       className="w-full py-3 text-xs font-semibold tracking-wide transition-all rounded-xl border border-white/[0.1] bg-[#FFCE99]/32 text-white/[0.6] hover:text-white/[0.85]"
      >
       취소
      </button>
     </div>
    </div>
   </div>
  </div>
 );
}
