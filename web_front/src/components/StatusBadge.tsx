interface Props {
  connected: boolean;
  error: unknown;
}

export default function StatusBadge({ connected, error }: Props) {
  if (connected)
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shadow-sm shadow-green-400/50" />
        연결됨
      </span>
    );
  if (error)
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-red-400">
        <span className="w-2 h-2 rounded-full bg-red-400" />
        오류
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-sm font-medium text-amber-400">
      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      연결 중...
    </span>
  );
}
