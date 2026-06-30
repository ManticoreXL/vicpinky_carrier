import { useState, useEffect, type ReactNode } from "react";

// 검색 가능한 리스트 선택칸 (유형/맵/목적지 공통) — 밝은 테마, 정해진 박스에 나열.
export function Picker({ label, items, value, onSelect }: {
  label: ReactNode;
  items: { v: string; l: string; sub?: string; tone?: string }[];
  value: string;
  onSelect: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(true);
  // 값이 지워지면(유형 변경 등) 다시 펼친다
  useEffect(() => { if (!value) setOpen(true); }, [value]);
  const sel = items.find((it) => it.v === value);
  const f = items.filter((it) => `${it.l} ${it.sub ?? ""} ${it.v}`.toLowerCase().includes(q.toLowerCase().trim()));

  return (
    <div>
      <div className="text-[9px] font-bold tracking-widest text-white/40 uppercase mb-1">{label}</div>
      {value && !open ? (
        // 선택됨 — 칩으로 접어 표시(클릭하면 다시 펼침)
        <button onClick={() => setOpen(true)}
          className="w-full flex items-center gap-2 bg-sky-500/20 border border-sky-400/50 rounded-lg px-2.5 py-1.5 text-[11px] text-white font-bold hover:bg-sky-500/30">
          {sel?.tone && <span className={`w-2 h-2 rounded-full flex-none ${sel.tone}`} />}
          <span className="truncate">{sel?.l ?? value}</span>
          {sel?.sub && <span className="text-[8px] text-sky-100/70 font-normal">{sel.sub}</span>}
          <span className="ml-auto text-[9px] text-white/40 font-normal">변경 ▾</span>
        </button>
      ) : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색…"
            className="w-full bg-white/[0.06] border border-white/[0.15] rounded-t-lg px-2.5 py-1.5 text-[11px] text-white/85 placeholder:text-white/40 focus:outline-none focus:border-white/30" />
          <div className="max-h-[112px] overflow-y-auto flex flex-col gap-0.5 border border-t-0 border-white/[0.15] rounded-b-lg bg-white/[0.06] p-1">
            {f.length === 0 ? <div className="px-2 py-1 text-[10px] text-white/40">없음</div>
              : f.map((it) => (
                <button key={it.v || it.l} onClick={() => { onSelect(it.v); setOpen(false); }}
                  className={`flex items-center gap-1.5 text-left px-2 py-1 rounded text-[11px] transition-colors ${value === it.v ? "bg-sky-500/25 text-white font-bold" : "text-white/85 hover:bg-white/[0.1]"}`}>
                  {it.tone && <span className={`w-2 h-2 rounded-full flex-none ${it.tone}`} />}
                  <span className="truncate">{it.l}</span>
                  {it.sub && <span className="ml-auto text-[8px] text-white/40 flex-none">{it.sub}</span>}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
