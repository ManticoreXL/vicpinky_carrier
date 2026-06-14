interface Props { connected: boolean; error: unknown }

export default function StatusBadge({ connected, error }: Props) {
  if (connected)
    return (
      <span className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400
                       tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                       bg-emerald-500/10 border border-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        ROS
      </span>
    );
  if (error)
    return (
      <span className="flex items-center gap-1.5 text-[10px] font-bold text-red-400
                       tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                       bg-red-500/10 border border-red-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        ERR
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold text-white/35
                     tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                     bg-white/[0.04] border border-white/[0.06]">
      <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-pulse" />
      CONN
    </span>
  );
}
