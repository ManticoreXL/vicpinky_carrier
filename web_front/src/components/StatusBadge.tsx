interface Props { connected: boolean; error: unknown }

export default function StatusBadge({ connected, error }: Props) {
  if (connected)
    return (
      <span className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-600
                       tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                       bg-emerald-500/10 border border-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        ROS
      </span>
    );
  if (error)
    return (
      <span className="flex items-center gap-1.5 text-[10px] font-bold text-red-600
                       tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                       bg-red-500/10 border border-red-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        ERR
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold text-white/[0.55]
                     tracking-widest uppercase px-2.5 py-1.5 rounded-lg
                     bg-[#FFCE99]/32 border border-white/[0.1]">
      <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-pulse" />
      CONN
    </span>
  );
}
