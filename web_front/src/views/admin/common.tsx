// AdminView 공통 소형 컴포넌트
import { BTN } from "./styles";
import type { NodeType } from "./types";

export function SectionHeader({ title, count, onAdd, onRefresh, loading, noMargin }: {
  title: string; count: number; onAdd: () => void; onRefresh: () => void; loading: boolean; noMargin?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${noMargin ? "" : "mb-2"}`}>
      <h2 className="text-xs font-bold text-white/[0.75] tracking-wide">{title}</h2>
      <span className="text-xs text-white/[0.6] ">{count}건</span>
      <div className="flex-1" />
      <button
        className={BTN("bg-[#FFCE99]/32 text-white/[0.75] border-white/[0.1] hover:text-white/90") + " text-xs"}
        onClick={onRefresh}
        disabled={loading}
      >{loading ? "..." : "새로고침"}</button>
      <button
        className={BTN("bg-blue-950/60 text-white/90 border-white/[0.1] hover:bg-blue-900/50")}
        onClick={onAdd}
      >+ 추가</button>
    </div>
  );
}

export function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-white/[0.1]">
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

export function ErrBar({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="mb-2 px-3 py-2 bg-red-950/40 border border-white/[0.1] rounded text-xs text-white/90 flex justify-between">
      {msg}
      <button className="text-white/[0.68] hover:text-white/90 ml-4" onClick={onClose}>✕</button>
    </div>
  );
}

export function NodeTypeBadge({ type }: { type: NodeType }) {
  const c = type === "WAYPOINT" ? "text-white/90" : type === "STATION" ? "text-white/90" : "text-white/90";
  return <span className={`font-bold text-xs ${c}`}>{type}</span>;
}
