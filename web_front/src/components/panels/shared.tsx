import { type ReactNode } from "react";

// 패널 공용 UI 컴포넌트 — 재난 테마 (검정·은색·빨강). 여러 패널이 공유한다.
// (이전엔 BigPinkyPanel.tsx 안에 정의돼 있었음 — 구체 패널 의존을 없애려고 분리)

export function PanelCard({
 title, icon, accent = "blue", badge, children,
}: {
 title: string; icon: string;
 accent?: "amber" | "blue" | "orange";
 badge?: string;
 children: ReactNode;
}) {
 return (
 <div className="bg-[#FFCE99]/32 border border-white/[0.1] rounded-none p-5 flex flex-col gap-4
 shadow-2xl shadow-black/80 border-glow-red">
 <div className="flex items-center justify-between border-b border-white/[0.1] pb-3">
 <h2 className="text-sm font-semibold text-white/90 tracking-wide flex items-center gap-2">
 <span className="text-red-600 text-base">{icon}</span>
 {title}
 </h2>
 {badge && (
 <span className="text-xs font-bold px-2 py-0.5 border border-white/[0.1]
 bg-red-950/20 text-red-600 tracking-wide ">
 {badge}
 </span>
 )}
 </div>
 {children}
 </div>
 );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
 return (
 <div className="flex flex-col gap-1.5">
 <div className="flex items-center gap-2">
 <span className="text-red-700/60 text-xs">◆</span>
 <p className="text-xs font-bold text-white/[0.6] tracking-[0.25em]">{label}</p>
 <div className="flex-1 h-px bg-red-900/20" />
 </div>
 <div className="bg-[#FFCE99]/32 p-3 border border-white/[0.1]">{children}</div>
 </div>
 );
}

export function BatteryBar({ pct }: { pct: number }) {
 const fill = pct < 20 ? "bg-red-700" : pct < 50 ? "bg-amber-400" : "bg-green-700";
 const text = pct < 20 ? "text-white/90" : pct < 50 ? "text-white/[0.75]" : "text-green-600";
 return (
 <div className="flex items-center gap-3">
 <div className="flex-1 h-1.5 bg-[#FFCE99]/32 overflow-hidden border border-white/[0.1]">
 <div className={`h-full transition-all ${fill}`} style={{ width: `${pct}%` }} />
 </div>
 <span className={`text-xs font-semibold tabular-nums w-10 text-right ${text}`}>{pct}%</span>
 </div>
 );
}

export function GoldButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
 return (
 <button onClick={onClick}
 className="px-4 py-1.5 border border-white/[0.1] bg-red-950/30 hover:bg-red-900/50
 text-white/90 text-xs font-bold tracking-wide transition-all
 hover:border-white/[0.1] hover:text-white/[0.82]">
 {children}
 </button>
 );
}

export function BlueButton({ onClick, children, disabled = false }: {
 onClick: () => void;
 children: ReactNode;
 disabled?: boolean;
}) {
 return (
 <button
 onClick={onClick}
 disabled={disabled}
 className={`px-4 py-1.5 border text-xs font-bold tracking-wide transition-all ${
 disabled
 ? "border-white/[0.1] bg-transparent text-white/[0.55] cursor-not-allowed"
 : "border-white/[0.1] bg-[#FFCE99]/32 hover:bg-[#FFCE99]/32 text-white/[0.75] hover:border-white/[0.1] hover:text-white/90"
 }`}
 >
 {children}
 </button>
 );
}

export function DangerButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
 return (
 <button onClick={onClick}
 className="px-4 py-1.5 border border-white/[0.1] bg-red-900/40 hover:bg-red-800/60
 text-white/[0.82] text-xs font-bold tracking-wide transition-all
 hover:border-red-600 hover:text-red-800">
 {children}
 </button>
 );
}

export function NoData() {
 return <span className="text-xs text-white/[0.55] tracking-wide">NO DATA</span>;
}
