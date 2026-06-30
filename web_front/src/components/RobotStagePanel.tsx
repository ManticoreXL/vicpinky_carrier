import { useEffect, useState } from "react";
import { useRos } from "../hooks/useRos";

// ── 터틀봇 stage 표시 (제어 화면 전용) ──────────────────────────────────────────────
// 모든 터틀봇이 쏘는 /<botId>/robot_state 의 stage(문자열)를 rosbridge로 "프론트에서 직접" 구독해 표시.
// ⚠ 기존 백엔드/소켓/앱 로직과 전혀 겹치지 않는다 — 자체 useRos(자체 rosbridge 연결)로 읽기만 한다.
//    (다른 브리지 토픽 /tb3_01/battery_state 등과 동일한 per-robot 네임스페이스 가정)
//
// messageType은 ""(미지정) — rosbridge가 토픽의 실제 타입을 해석한다. 메시지에서 stage 문자열만 읽으므로
// 타입을 몰라도 동작한다. (만약 구독이 안 들어오면 실제 메시지 타입을 STATE_TYPE에 넣으면 됨)
const STATE_TYPE = "";

export default function RobotStagePanel({ botId }: { botId: string }) {
  const { ros, connected } = useRos();
  const [stage, setStage] = useState("");

  useEffect(() => {
    setStage(""); // 로봇 전환 시 초기화
    if (!connected || !ros || !window.ROSLIB) return;
    const topic = new window.ROSLIB.Topic({ ros, name: `/${botId}/robot_state`, messageType: STATE_TYPE });
    topic.subscribe((msg) => {
      const s = (msg as { stage?: unknown }).stage;
      if (typeof s === "string") setStage(s);
    });
    return () => { try { topic.unsubscribe(); } catch { /* noop */ } };
  }, [connected, ros, botId]);

  return (
    <div className="mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/30 shadow-sm">
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
      <span className="text-[10px] font-extrabold tracking-widest text-amber-700/80">STAGE</span>
      <span className="font-mono font-extrabold text-[13px] text-amber-700">{stage || "—"}</span>
      <span className="text-[10px] text-amber-700/45">· {botId}</span>
    </div>
  );
}
