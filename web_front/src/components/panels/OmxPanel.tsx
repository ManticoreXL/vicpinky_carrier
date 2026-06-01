import { useEffect, useState } from "react";
import { PanelProps } from "../../hooks/useRos";
import { PanelCard, Section, GoldButton, BlueButton, DangerButton } from "./BigPinkyPanel";

interface StringMsg { data: string }

const ARMS = ["omx1", "omx2"] as const;
type ArmId = (typeof ARMS)[number];

const stateColor = (s: string) =>
  s === "load"    ? "text-amber-400" :
  s === "unload"  ? "text-blue-400" :
  s === "home"    ? "text-green-400" : "text-blue-400/40";

export default function OmxPanel({ subscribe, publish }: PanelProps) {
  const [states, setStates] = useState<Record<ArmId, string>>({ omx1: "unknown", omx2: "unknown" });

  useEffect(() => {
    const subs = ARMS.map((id) =>
      subscribe<StringMsg>(`/bigpinky/${id}/state`, "std_msgs/String",
        (m) => setStates((p) => ({ ...p, [id]: m.data })))
    );
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [subscribe]);

  const sendCmd = (id: ArmId, cmd: string) =>
    publish(`/bigpinky/${id}/cmd`, "std_msgs/String", { data: cmd });

  return (
    <div className="max-w-md flex flex-col gap-4">
      <PanelCard title="OMX 로봇팔" icon="🦾" accent="orange">
        {ARMS.map((id) => (
          <Section key={id} label={id.toUpperCase()}>
            <div className="flex items-center justify-between gap-4">
              <span className={`text-2xl font-bold capitalize ${stateColor(states[id])}`}>
                {states[id]}
              </span>
              <div className="flex gap-2">
                <GoldButton onClick={() => sendCmd(id, "load")}>적재</GoldButton>
                <BlueButton onClick={() => sendCmd(id, "unload")}>하역</BlueButton>
                <DangerButton onClick={() => sendCmd(id, "home")}>홈</DangerButton>
              </div>
            </div>
          </Section>
        ))}
      </PanelCard>
    </div>
  );
}
