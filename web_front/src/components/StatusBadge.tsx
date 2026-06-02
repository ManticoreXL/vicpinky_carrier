interface Props { connected: boolean; error: unknown }

export default function StatusBadge({ connected, error }: Props) {
  if (connected)
    return (
      <span className="flex items-center gap-1.5 text-xs font-mono font-bold text-green-500 uppercase tracking-widest">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shadow shadow-green-500/60" />
        ONLINE
      </span>
    );
  if (error)
    return (
      <span className="flex items-center gap-1.5 text-xs font-mono font-bold text-red-500 uppercase tracking-widest">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        ERROR
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono font-bold text-[#888] uppercase tracking-widest">
      <span className="w-1.5 h-1.5 rounded-full bg-[#888] animate-pulse" />
      CONNECTING
    </span>
  );
}
