import { useState, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type RankedRobot } from "../../utils/robotRanking";
import { INP, robotIcon, type Opt } from "./shared";
import { isTestBot } from "../../robots";

// 추천 랭킹 1건 → 리치 옵션 행(순위 배지·아이콘·상태칩·거리·배터리). 1위는 ★ 강조.
export function rankRowLabel(r: RankedRobot): ReactNode {
  const top = r.rank === 1 && r.online;
  return (
    <span className="flex items-center gap-1.5 min-w-0 w-full">
      <span className={`flex-none w-6 text-center text-[10px] font-extrabold ${top ? "text-amber-300" : "text-white/40"}`}>{top ? "★" : `#${r.rank}`}</span>
      <span className="flex-none text-sm leading-none">{robotIcon(r.robotId)}</span>
      <span className="font-mono font-bold truncate flex-1 min-w-0">{r.robotId}</span>
      <span className={`flex-none text-[9px] font-bold px-1 py-0.5 rounded ${r.error ? "bg-rose-500/40 text-rose-50" : r.online ? (r.busy ? "bg-sky-500/30 text-sky-100" : "bg-emerald-500/30 text-emerald-100") : "bg-white/10 text-white/40"}`}>
        {r.error ? "오류" : r.online ? (r.busy ? "작업중" : "대기") : "오프라인"}
      </span>
      {r.distance != null && <span className="flex-none text-[9px] font-mono text-white/55">{r.distance.toFixed(1)}m</span>}
      {r.batteryPct != null && <span className={`flex-none text-[9px] font-mono ${r.batteryPct < 40 ? "text-rose-300" : "text-white/55"}`}>{r.batteryPct}%</span>}
    </span>
  );
}

// 추천 랭킹 → 드롭다운 옵션(추천 순서). 공급은 omx만, 그 외 omx 제외. 오프라인은 비활성.
// 가상 테스트봇은 운영 배정 선택지에서 제외한다.
export function rankingToOptions(ranking: RankedRobot[], isSupply: boolean): Opt[] {
  return ranking
    .filter((r) => !isTestBot(r.robotId) && (isSupply ? r.robotId.startsWith("omx") : !r.robotId.startsWith("omx")))
    .map((r) => ({ value: r.robotId, label: rankRowLabel(r), selectedLabel: `#${r.rank} ${r.robotId}`, disabled: !r.online || !!r.error }));
}

// 네이티브 select 대신 커스텀 드롭다운 — 메뉴를 포털로 렌더해 overflow 안에서도 안 잘리고, 다크 테마로 또렷하게.
export function Dropdown({ value, onChange, options, placeholder, className, title, onOpen, menuHeader }: {
  value: string; onChange: (v: string) => void; options: Opt[];
  placeholder?: string; className?: string; title?: string; onOpen?: () => void; menuHeader?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 메뉴 내부 스크롤(옵션 리스트)은 닫지 않음 — 그 외 페이지 스크롤/리사이즈만 닫음
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen(true);
    onOpen?.(); // 펼칠 때마다 콜백(추천 로봇 재계산 등)
  };

  const selected = options.find((o) => o.value === value && !o.disabled);
  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`} title={title}>
      <button type="button" onClick={toggle}
        className={`${INP} w-full flex items-center justify-between gap-1 cursor-pointer hover:border-white/[0.25]`}>
        <span className="truncate">{selected ? (selected.selectedLabel ?? selected.label) : (placeholder ?? "")}</span>
        <span className="flex-none text-white/40 text-[8px]">▼</span>
      </button>
      {open && rect && createPortal(
        <div ref={menuRef}
          style={{ position: "fixed", top: rect.bottom + 4, left: rect.left, minWidth: rect.width }}
          className="z-[1000] w-max max-w-[320px] max-h-[280px] overflow-y-auto rounded-xl bg-[#FFCE99]/32 backdrop-blur-2xl border border-white/[0.1] shadow-2xl py-1">
          {menuHeader && (
            <div className="px-2.5 py-1 text-[9px] font-bold tracking-widest text-amber-200/80 uppercase border-b border-white/[0.1] mb-1 sticky top-0 bg-[#FFCE99]/32 backdrop-blur-2xl">
              {menuHeader}
            </div>
          )}
          {options.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-white/35">목록 없음</div>}
          {options.map((o, i) => (
            <button key={o.value || i} type="button" disabled={o.disabled}
              onClick={() => { if (!o.disabled) { onChange(o.value); setOpen(false); } }}
              className={`flex w-full items-center text-left px-2.5 py-1.5 text-[11px] transition-colors ${o.disabled ? "text-white/30 cursor-default" : o.value === value ? "bg-white/15 text-white font-bold" : "text-white/85 hover:bg-white/[0.08]"}`}>
              {o.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
