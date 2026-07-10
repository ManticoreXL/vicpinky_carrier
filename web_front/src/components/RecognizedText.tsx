import type { RosMessage } from "../hooks/useNestSocket";

// 로봇의 최신 음성인식 텍스트 — /{robotId}/recognized_text (std_msgs/String).
// 백엔드가 구독→forward한 rosMessages에서 읽는다. 없으면 null.
export function recognizedTextOf(
  robotId: string,
  rosMessages: Record<string, RosMessage>,
): { text: string; ts: number } | null {
  const m = rosMessages[`/${robotId}/recognized_text`];
  const text = (m?.data as { data?: string } | undefined)?.data;
  if (!m || !text || !text.trim()) return null;
  return { text: text.trim(), ts: m.timestamp };
}

// 최신 음성인식 텍스트 한 줄 캡션 (제어/플릿 공용). 텍스트가 없으면 아무것도 렌더하지 않는다.
// 새 메시지가 오면 rosMessages가 갱신되며 캡션이 그 텍스트로 하나씩 바뀐다.
export default function RecognizedCaption({
  robotId,
  rosMessages,
  showRobot = false,
  className = "",
}: {
  robotId: string;
  rosMessages: Record<string, RosMessage>;
  showRobot?: boolean;
  className?: string;
}) {
  const r = recognizedTextOf(robotId, rosMessages);
  if (!r) return null;
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sky-400/40 bg-sky-500/12 max-w-full ${className}`}
      title={r.text}
    >
      <span className="text-[11px] leading-none flex-none">🗣</span>
      {showRobot && <span className="text-[10px] font-bold text-sky-700 flex-none">{robotId}</span>}
      <span className="text-xs font-medium text-sky-700 truncate">{r.text}</span>
    </div>
  );
}
