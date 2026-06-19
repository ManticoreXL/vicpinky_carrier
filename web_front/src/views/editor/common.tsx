// TopologyEditor 사이드 패널 소형 컴포넌트

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-white/[0.1] px-3 py-3">
      <div className="text-xs text-white/[0.68] tracking-wide mb-2">{title}</div>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="text-xs text-white/[0.6] mb-0.5 tracking-wider">{label}</div>
      {children}
    </div>
  );
}
