import { useEffect, useState, useCallback } from "react";
import { PanelProps } from "../../hooks/useRos";
import { PanelCard, Section } from "./shared";

interface BoolMsg { data: boolean }

interface Props extends PanelProps {
  callService: (serviceName: string, serviceType: string, request: Record<string, unknown>, callback: (res: unknown) => void) => void;
}

// 비전 감지 한 줄 — Bool 토픽 상태 표시
function VisionRow({ label, topic, on, seen, onLabel, offLabel, tone }: {
  label: string; topic: string; on: boolean; seen: boolean;
  onLabel: string; offLabel: string; tone: "emerald" | "red" | "blue";
}) {
  const onCls = tone === "red" ? "bg-rose-500 text-white" : tone === "blue" ? "bg-sky-500 text-white" : "bg-emerald-500 text-black";
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]">
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-white/85">{label}</div>
        <div className="text-[10px] text-white/40 font-mono truncate">{topic}</div>
      </div>
      <span className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-extrabold whitespace-nowrap ${!seen ? "bg-white/10 text-white/40" : on ? onCls : "bg-white/10 text-white/55"}`}>
        <span className={`w-2 h-2 rounded-full ${!seen ? "bg-white/25" : on ? "bg-white/90" : "bg-white/40"}`} />
        {!seen ? "수신 없음" : on ? onLabel : offLabel}
      </span>
    </div>
  );
}

// OMX 로봇팔 — 비전 추론 시작(토픽 발행) + 적재/물체 감지 상태(토픽 구독).
export default function OmxPanel({ subscribe, publish }: Props) {
  const [loaded, setLoaded] = useState(false); // /omx/vision/is_loaded
  const [red, setRed]       = useState(false); // /omx/vision/object_red
  const [blue, setBlue]     = useState(false); // /omx/vision/object_blue
  const [seen, setSeen]     = useState({ loaded: false, red: false, blue: false }); // 토픽 수신 여부

  // 허브(49)에서 /omx/vision/* 로 노출되는 omx 비전 토픽 구독 (std_msgs/Bool)
  useEffect(() => {
    const subs = [
      subscribe<BoolMsg>("/omx/vision/is_loaded",   "std_msgs/msg/Bool", (m) => { setLoaded(!!m.data); setSeen((s) => ({ ...s, loaded: true })); }),
      subscribe<BoolMsg>("/omx/vision/object_red",  "std_msgs/msg/Bool", (m) => { setRed(!!m.data);    setSeen((s) => ({ ...s, red: true })); }),
      subscribe<BoolMsg>("/omx/vision/object_blue", "std_msgs/msg/Bool", (m) => { setBlue(!!m.data);   setSeen((s) => ({ ...s, blue: true })); }),
    ];
    return () => subs.forEach((sub) => sub?.unsubscribe());
  }, [subscribe]);

  // 색상 추론 시작 — 신호 1회 발행(완료 대기 없음). 허브(49) → 브릿지 → omx(45) /vision/start_blue|red
  const [sent, setSent] = useState<"" | "blue" | "red">("");
  const startColor = useCallback((color: "blue" | "red") => {
    publish(`/omx/vision/start_${color}`, "std_msgs/Bool", { data: true });
    setSent(color);
    setTimeout(() => setSent(""), 1500);
  }, [publish]);

  return (
    <div className="max-w-md flex flex-col gap-4">
      <PanelCard title="OMX 로봇팔" icon="🦾" accent="orange">
        {/* 색상 추론 시작 — 토픽 발행 (신호 1회, 완료 대기 없음) */}
        <Section label="색상 추론 시작">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => startColor("blue")}
              className={`px-4 py-2 text-sm font-bold rounded-lg border transition-all ${sent === "blue" ? "bg-sky-500 border-sky-400 text-white" : "bg-sky-600/25 border-sky-500/50 text-sky-700 hover:bg-sky-600/40"}`}>
              🔵 파랑 추론{sent === "blue" ? " · 보냄" : ""}
            </button>
            <button onClick={() => startColor("red")}
              className={`px-4 py-2 text-sm font-bold rounded-lg border transition-all ${sent === "red" ? "bg-rose-500 border-rose-400 text-white" : "bg-rose-600/25 border-rose-500/50 text-rose-700 hover:bg-rose-600/40"}`}>
              🔴 빨강 추론{sent === "red" ? " · 보냄" : ""}
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-white/40 font-mono">/vision/start_blue · /vision/start_red</div>
        </Section>

        {/* 비전 감지 상태 — 토픽 구독(Bool) */}
        <Section label="비전 감지 상태">
          <div className="space-y-2">
            <VisionRow label="적재 완료" topic="/vision/is_loaded"   on={loaded} seen={seen.loaded} onLabel="적재됨" offLabel="대기"  tone="emerald" />
            <VisionRow label="빨강 물체" topic="/vision/object_red"  on={red}    seen={seen.red}    onLabel="감지"   offLabel="없음" tone="red" />
            <VisionRow label="파랑 물체" topic="/vision/object_blue" on={blue}   seen={seen.blue}   onLabel="감지"   offLabel="없음" tone="blue" />
          </div>
        </Section>
      </PanelCard>
    </div>
  );
}
