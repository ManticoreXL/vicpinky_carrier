import { useState, useEffect, useCallback, type ReactNode } from "react";
import { BACKEND_URL } from "../config";
import type { RobotInfo } from "../hooks/useNestSocket";
import { robotIcon } from "../components/taskqueue/shared";
import { Picker } from "../components/taskqueue/Picker";
import { parseVal } from "../utils/parseVal";

// ── 타입 ──────────────────────────────────────────────────────────────────
type TopoNode = { node_id: string; map_id: string; type: string; x?: number; y?: number };
// 백엔드 RosStep 과 동일 구조(혼합 스텝). topic 외 robot-scoped 스텝은 실행 시 로봇으로 retarget.
type Step = { kind: string; topicName: string; messageType: string; message: Record<string, unknown>; awaitNodeId: string | null; awaitKind: string; waitMs: number; awaitTopic?: string; awaitField?: string; awaitValue?: unknown; endTopic?: string; endField?: string; endValue?: unknown };
type TaskDef = { _id: string; name: string; targetNode: string; preferredRobotId: string | null; priority?: number; repeat?: boolean; triggerTopic?: string; triggerField?: string; triggerValue?: unknown; steps: Step[]; description?: string };

const PH = "robot"; // robot-scoped 스텝 topicName 의 자리표시자 — 실행 시 retargetStep 이 실제 로봇으로 치환
const STEP_KINDS = [["move", "이동"], ["service", "서비스"], ["action", "액션"], ["topic", "토픽"], ["wait", "대기"]] as const;
const KIND_KO: Record<string, string> = { move: "이동", service: "서비스", action: "액션", topic: "토픽", wait: "대기", supply: "보급" };
const KIND_DOT: Record<string, string> = { move: "bg-sky-500", service: "bg-rose-500", action: "bg-fuchsia-500", topic: "bg-violet-500", wait: "bg-amber-500" };

// 우선순위 1=긴급 … 5=보통 … 10=낮음
const PRIORITIES = [[1, "긴급"], [3, "높음"], [5, "보통"], [8, "낮음"]] as const;
const PRIO_DOT: Record<number, string> = { 1: "bg-rose-500", 3: "bg-orange-500", 5: "bg-emerald-500", 8: "bg-slate-400" };
const prioKo = (p?: number) => (p === 1 ? "긴급" : p === 3 ? "높음" : (p ?? 5) >= 8 ? "낮음" : "보통");
const prioDot = (p?: number) => (p === 1 ? "bg-rose-500" : p === 3 ? "bg-orange-500" : (p ?? 5) >= 8 ? "bg-slate-400" : "bg-emerald-500");

const api = (path: string, opts?: RequestInit) =>
  fetch(`${BACKEND_URL}/api/fms${path}`, { headers: { "Content-Type": "application/json" }, ...opts });

// 하나의 태스크 = ROS 액션 스텝(들어오는 값/결과값) + 목적 노드 + 실행 로봇. 화면에서 조립 → 저장 → 테스트(실행).
export default function BuilderView({ robots }: { robots: RobotInfo[] }) {
  const [nodes, setNodes] = useState<TopoNode[]>([]);
  const [defs, setDefs] = useState<TaskDef[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const robotIds = robots.map((r) => r.robot_id);
  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2500); };

  const reloadDefs = useCallback(() => { void api("/task-defs").then((r) => r.json()).then((d) => Array.isArray(d) && setDefs(d)).catch(() => {}); }, []);
  useEffect(() => {
    void fetch(`${BACKEND_URL}/api/fleet/topology/nodes`).then((r) => r.json()).then((d) => Array.isArray(d) && setNodes(d)).catch(() => {});
    reloadDefs();
  }, [reloadDefs]);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 text-white/85">
      <div className="max-w-[1100px] mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-base font-extrabold text-white">🧱 태스크 빌더</span>
          <span className="text-[11px] text-white/50">ROS 액션을 묶어 하나의 태스크로 정의 → 저장 → 테스트</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TaskBuilder nodes={nodes} robotIds={robotIds} onSaved={() => { reloadDefs(); flash("저장됨"); }} />
          <SavedTasks defs={defs}
            onRun={(id, name) => void api(`/task-defs/${id}/run`, { method: "POST", body: "{}" }).then((r) => { if (!r.ok) throw new Error(); flash(`실행: ${name}`); }).catch(() => flash("실행 실패 — 온라인 로봇/설정 확인"))}
            onDelete={(id) => void api(`/task-defs/${id}`, { method: "DELETE" }).then(() => reloadDefs())} />
        </div>
      </div>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[2000] px-4 py-2 rounded-xl glass-panel text-[12px] font-bold text-white shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── 패널 공통 ────────────────────────────────────────────────────────────
const Panel = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <div className="glass-card p-3.5 flex flex-col gap-2.5 min-h-[200px]">
    <div className="flex items-baseline gap-2">
      <span className="text-[13px] font-extrabold text-white">{title}</span>
      {hint && <span className="text-[10px] text-white/40">{hint}</span>}
    </div>
    {children}
  </div>
);
const Lbl = (t: string, extra?: ReactNode) => (
  <div className="text-[9px] font-bold tracking-widest text-white/40 uppercase mb-1">{t} {extra}</div>
);
const INP = "w-full bg-white/[0.06] border border-white/[0.12] rounded-lg px-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/35 focus:outline-none focus:border-white/30";

const DEFAULT_ROBOT_IDS = ["vicpinky", "omx", "tb3_01", "tb3_02", "tb3_03", "tb3_04", "TEST-BOT1", "TEST-BOT2", "TEST-BOT3", "TEST-BOT4"];
// 로봇 선택 — 칩 목록 (미지정 허용). 백엔드가 아는 로봇(ids)이 있으면 그걸, 없으면 기본 로스터.
function RobotChips({ value, onSelect, ids, allowEmpty = true }: { value: string; onSelect: (v: string) => void; ids?: string[]; allowEmpty?: boolean }) {
  const list = ids && ids.length ? ids : DEFAULT_ROBOT_IDS;
  return (
    <div className="flex flex-wrap gap-1">
      {allowEmpty && (
        <button onClick={() => onSelect("")} title="비우면 실행 시 추천 랭킹으로 로봇을 자동 배정합니다"
          className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${!value ? "bg-amber-400/25 text-amber-700 border-amber-400/40" : "bg-white/[0.06] text-white/60 border-white/[0.1] hover:bg-white/[0.1]"}`}>🎯 추천 자동</button>
      )}
      {list.map((id) => (
        <button key={id} onClick={() => onSelect(id)}
          className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all flex items-center gap-1 ${value === id ? "bg-sky-500/25 text-white border-sky-400/50" : "bg-white/[0.06] text-white/70 border-white/[0.1] hover:bg-white/[0.1]"}`}>
          <span>{robotIcon(id)}</span>{id}
        </button>
      ))}
    </div>
  );
}

// ── 태스크 만들기 — 이름 + 목적 노드 + 실행 로봇 + ROS 액션 스텝 ──────────────
function TaskBuilder({ nodes, robotIds, onSaved }: { nodes: TopoNode[]; robotIds: string[]; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [prefRobot, setPrefRobot] = useState("");
  const [priority, setPriority] = useState(5);
  const [repeat, setRepeat] = useState(false);
  const [trigOn, setTrigOn] = useState(false);   // 생성 조건(트리거) 사용
  const [trigTopic, setTrigTopic] = useState("");
  const [trigField, setTrigField] = useState("");
  const [trigValue, setTrigValue] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!name.trim()) { setErr("이름을 입력하세요"); return; }
    if (trigOn && !trigTopic.trim()) { setErr("트리거 토픽을 입력하세요"); return; }
    try {
      const body: Record<string, unknown> = { name: name.trim(), preferredRobotId: prefRobot || null, priority, repeat, steps };
      if (trigOn && trigTopic.trim()) { body.triggerTopic = trigTopic.trim(); body.triggerField = trigField.trim(); body.triggerValue = parseVal(trigValue); }
      const r = await api("/task-defs", { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setName(""); setPrefRobot(""); setPriority(5); setRepeat(false); setSteps([]); setErr("");
      setTrigOn(false); setTrigTopic(""); setTrigField(""); setTrigValue(""); onSaved();
    } catch (e) { setErr(`저장 실패: ${String(e)}`); }
  };

  return (
    <Panel title="태스크 만들기" hint="ROS 액션 스텝 + 실행 로봇">
      <div>{Lbl("이름")}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: N3 구역 전개" className={INP} />
      </div>

      {/* 생성 조건(트리거) — auto 모드 ON일 때 이 ROS 신호가 오면 이 태스크를 자동 생성·배차 */}
      <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] p-2.5 flex flex-col gap-2">
        <button onClick={() => setTrigOn((v) => !v)} className="flex items-center justify-between w-full">
          <span className="text-[11px] font-bold text-sky-700">⚡ 생성 조건(자동) <span className="text-white/40 font-normal">ROS 신호 오면 자동 생성</span></span>
          <span className={`relative w-9 h-5 rounded-full flex-none transition-colors ${trigOn ? "bg-sky-400" : "bg-white/15"}`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper shadow transition-all ${trigOn ? "left-[18px]" : "left-0.5"}`} />
          </span>
        </button>
        {trigOn && (
          <>
            <input value={trigTopic} onChange={(e) => setTrigTopic(e.target.value)} placeholder="트리거 토픽 (예: /sensor/alarm)" className={INP} />
            <input value={trigField} onChange={(e) => setTrigField(e.target.value)} placeholder="필드 (빈값=수신만으로)" className={INP} />
            <input value={trigValue} onChange={(e) => setTrigValue(e.target.value)} placeholder="기대값 (예: 3 / true). 빈값=truthy" className={INP} />
            <span className="text-[9px] text-white/35">※ auto-dispatcher(자동) 모드가 켜져 있어야 동작합니다.</span>
          </>
        )}
      </div>

      <div>{Lbl("우선순위")}
        <div className="grid grid-cols-4 gap-1">
          {PRIORITIES.map(([v, ko]) => (
            <button key={v} onClick={() => setPriority(v)}
              className={`py-1.5 text-[11px] font-bold rounded-lg border transition-all ${priority === v ? `${PRIO_DOT[v]} text-paper border-transparent shadow` : "bg-white/[0.06] text-white/70 border-white/[0.1] hover:bg-white/[0.1]"}`}>
              {ko}
            </button>
          ))}
        </div>
      </div>
      <div>{Lbl("실행 로봇", <span className="normal-case text-amber-600/80">· 비우면 추천 자동</span>)}<RobotChips value={prefRobot} onSelect={setPrefRobot} ids={robotIds} /></div>

      {/* ROS 액션 스텝 — 이동(노드)·서비스·액션·토픽·대기. 들어오는 값/결과값으로 완료 판정 */}
      <StepComposer nodes={nodes} steps={steps} setSteps={setSteps} />

      {/* 반복 수행 — 기존 연속(repeat) 메커니즘 재사용: 한 사이클 완료 후 정지 전까지 자동 재시작 */}
      <button onClick={() => setRepeat((v) => !v)}
        className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.1] hover:border-white/[0.2]">
        <span className="text-[11px] font-bold text-amber-700">🔁 반복 수행 <span className="text-white/40 font-normal">정지 전까지</span></span>
        <span className={`relative w-9 h-5 rounded-full flex-none transition-colors ${repeat ? "bg-amber-400" : "bg-white/15"}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper shadow transition-all ${repeat ? "left-[18px]" : "left-0.5"}`} />
        </span>
      </button>

      {err && <span className="text-[10px] text-rose-500 font-bold">{err}</span>}
      <button onClick={save} className="w-full py-2 text-[12px] font-extrabold rounded-lg bg-emerald-500 text-paper hover:bg-emerald-600 transition-colors">
        태스크 저장
      </button>
    </Panel>
  );
}

// 혼합 스텝(move/service/topic/wait) 조립
function StepComposer({ nodes, steps, setSteps }: { nodes: TopoNode[]; steps: Step[]; setSteps: (f: (s: Step[]) => Step[]) => void }) {
  const [kind, setKind] = useState<string>("service");
  const [moveNode, setMoveNode] = useState("");
  const [svcName, setSvcName] = useState("deploy");
  const [svcType, setSvcType] = useState("turtlebot_state_msgs/srv/Deploy");
  const [topicName, setTopicName] = useState("");
  const [msgType, setMsgType] = useState("std_msgs/Bool");
  const [jsonMsg, setJsonMsg] = useState('{ "data": true }');
  const [waitMs, setWaitMs] = useState(1000);
  const [waitMode, setWaitMode] = useState<"time" | "signal">("time");       // 시간 / 신호
  const [sigTopic, setSigTopic] = useState("/{robot}/done");
  const [sigField, setSigField] = useState("data");
  const [sigValue, setSigValue] = useState("true");
  const [actName, setActName] = useState("navigate_to_pose");
  const [actType, setActType] = useState("nav2_msgs/action/NavigateToPose");
  const [resCondOn, setResCondOn] = useState(false);  // 서비스/액션 결과값 조건 사용 여부
  const [resField, setResField] = useState("");
  const [resValue, setResValue] = useState("");
  const [endOn, setEndOn] = useState(false);          // 엔드(완료) 조건 — 기본 완료 후 외부 신호 대기
  const [endTopic, setEndTopic] = useState("/{robot}/done");
  const [endField, setEndField] = useState("data");
  const [endValue, setEndValue] = useState("true");
  const [serr, setSerr] = useState("");

  const parseJson = (): Record<string, unknown> | null => {
    try { const v = JSON.parse(jsonMsg || "{}"); return typeof v === "object" && v ? v : {}; } catch { return null; }
  };

  // 서비스/액션 결과값 조건 (켜져 있으면 awaitField/awaitValue 부여)
  const resCond = () => (resCondOn && resField.trim() ? { awaitField: resField.trim(), awaitValue: parseVal(resValue) } : {});
  // 엔드(완료) 조건 — 켜져 있으면 endTopic/endField/endValue 부여 (기본 완료 후 이 신호까지 대기)
  const endCond = () => (endOn && endTopic.trim() ? { endTopic: endTopic.trim(), endField: endField.trim(), endValue: parseVal(endValue) } : {});

  const add = () => {
    setSerr("");
    if (kind === "move") {
      const n = nodes.find((x) => x.node_id === moveNode);
      if (!n) { setSerr("이동할 노드를 선택하세요"); return; }
      setSteps((s) => [...s, {
        kind: "move", topicName: `/${PH}/goal_pose`, messageType: "geometry_msgs/PoseStamped",
        message: { pose: { position: { x: n.x ?? 0, y: n.y ?? 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
        awaitNodeId: n.node_id, awaitKind: "arrival", waitMs: 0, ...endCond(),
      }]);
      setMoveNode("");
    } else if (kind === "service") {
      if (!svcName.trim()) { setSerr("서비스명을 입력하세요"); return; }
      const req = parseJson(); if (req === null) { setSerr("요청 JSON 형식 오류"); return; }
      setSteps((s) => [...s, { kind: "service", topicName: `/${PH}/${svcName.trim().replace(/^\//, "")}`, messageType: svcType.trim(), message: req, awaitNodeId: null, awaitKind: "none", waitMs: 0, ...resCond(), ...endCond() }]);
    } else if (kind === "action") {
      if (!actName.trim()) { setSerr("액션명을 입력하세요"); return; }
      const goal = parseJson(); if (goal === null) { setSerr("goal JSON 형식 오류"); return; }
      const name = actName.trim();
      setSteps((s) => [...s, { kind: "action", topicName: name.startsWith("/") ? name : `/${PH}/${name}`, messageType: actType.trim(), message: goal, awaitNodeId: null, awaitKind: "none", waitMs: 0, ...resCond(), ...endCond() }]);
    } else if (kind === "topic") {
      if (!topicName.trim()) { setSerr("토픽명을 입력하세요"); return; }
      const msg = parseJson(); if (msg === null) { setSerr("메시지 JSON 형식 오류"); return; }
      setSteps((s) => [...s, { kind: "topic", topicName: topicName.trim(), messageType: msgType.trim(), message: msg, awaitNodeId: null, awaitKind: "none", waitMs: 0, ...endCond() }]);
    } else { // wait
      if (waitMode === "signal") {
        if (!sigTopic.trim()) { setSerr("신호 토픽을 입력하세요"); return; }
        setSteps((s) => [...s, { kind: "wait", topicName: `/${PH}/_wait`, messageType: "", message: {}, awaitNodeId: null, awaitKind: "signal", waitMs: 0, awaitTopic: sigTopic.trim(), awaitField: sigField.trim(), awaitValue: parseVal(sigValue) }]);
      } else {
        setSteps((s) => [...s, { kind: "wait", topicName: `/${PH}/_wait`, messageType: "", message: {}, awaitNodeId: null, awaitKind: "none", waitMs: Math.max(0, waitMs) }]);
      }
    }
    setEndOn(false); // 추가 성공 시 엔드조건 토글 해제(다음 스텝에 자동 적용 방지)
  };

  const nodeItems = nodes.map((n) => ({ v: n.node_id, l: n.node_id, sub: n.map_id }));
  const modeBtn = (on: boolean) => `py-1 text-[10px] font-bold rounded-lg border transition-all ${on ? "bg-white/25 text-white border-transparent" : "bg-white/[0.06] text-white/60 border-white/[0.1] hover:bg-white/[0.1]"}`;
  // 서비스/액션 공용 — 응답/result 의 특정 필드가 기대값과 일치할 때만 완료(아니면 실패)
  const resCondBlock = (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-1.5 flex flex-col gap-1.5">
      <button onClick={() => setResCondOn((v) => !v)} className="flex items-center justify-between text-[10px] font-bold text-white/70">
        <span>📨 응답 검증 <span className="text-white/35 font-normal">이 호출의 응답값 · 틀리면 실패</span></span>
        <span className={`px-1.5 py-0.5 rounded ${resCondOn ? "bg-emerald-500/30 text-emerald-50" : "bg-white/10 text-white/40"}`}>{resCondOn ? "ON" : "OFF"}</span>
      </button>
      {resCondOn && (<>
        <input value={resField} onChange={(e) => setResField(e.target.value)} placeholder="응답 필드 (예: success / code / driven_time)" className={INP} />
        <input value={resValue} onChange={(e) => setResValue(e.target.value)} placeholder="기대값 (예: true / 0). 불일치면 태스크 실패" className={INP} />
      </>)}
    </div>
  );

  return (
    <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] p-2.5 flex flex-col gap-2">
      {Lbl("혼합 스텝", <span className="normal-case text-white/35">비우면 유형+목적지로 자동</span>)}
      <div className="grid grid-cols-5 gap-1">
        {STEP_KINDS.map(([k, ko]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`py-1 text-[10px] font-bold rounded-lg border transition-all ${kind === k ? `${KIND_DOT[k]} text-paper border-transparent` : "bg-white/[0.06] text-white/65 border-white/[0.1] hover:bg-white/[0.1]"}`}>
            {ko}
          </button>
        ))}
      </div>

      {kind === "move" && <Picker label="이동할 노드" value={moveNode} items={nodeItems} onSelect={setMoveNode} />}
      {kind === "service" && (
        <div className="flex flex-col gap-1.5">
          <input value={svcName} onChange={(e) => setSvcName(e.target.value)} placeholder="서비스명 (예: deploy)" className={INP} />
          <input value={svcType} onChange={(e) => setSvcType(e.target.value)} placeholder="서비스 타입" className={INP} />
          <textarea value={jsonMsg} onChange={(e) => setJsonMsg(e.target.value)} rows={2} placeholder='요청 JSON' className={`${INP} font-mono resize-y`} />
          {resCondBlock}
        </div>
      )}
      {kind === "action" && (
        <div className="flex flex-col gap-1.5">
          <input value={actName} onChange={(e) => setActName(e.target.value)} placeholder="액션명 (예: navigate_to_pose)" className={INP} />
          <input value={actType} onChange={(e) => setActType(e.target.value)} placeholder="액션 타입 (예: nav2_msgs/action/NavigateToPose)" className={INP} />
          <textarea value={jsonMsg} onChange={(e) => setJsonMsg(e.target.value)} rows={2} placeholder='goal JSON' className={`${INP} font-mono resize-y`} />
          {resCondBlock}
        </div>
      )}
      {kind === "topic" && (
        <div className="flex flex-col gap-1.5">
          <input value={topicName} onChange={(e) => setTopicName(e.target.value)} placeholder="토픽명 (예: /TEST-BOT1/cmd)" className={INP} />
          <input value={msgType} onChange={(e) => setMsgType(e.target.value)} placeholder="메시지 타입" className={INP} />
          <textarea value={jsonMsg} onChange={(e) => setJsonMsg(e.target.value)} rows={2} placeholder='메시지 JSON' className={`${INP} font-mono resize-y`} />
        </div>
      )}
      {kind === "wait" && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-1">
            <button onClick={() => setWaitMode("time")} className={modeBtn(waitMode === "time")}>시간</button>
            <button onClick={() => setWaitMode("signal")} className={modeBtn(waitMode === "signal")}>신호(토픽)</button>
          </div>
          {waitMode === "time" ? (
            <div className="flex items-center gap-2">
              <input type="number" value={waitMs} min={0} step={100} onChange={(e) => setWaitMs(Number(e.target.value))} className={`${INP} w-28`} />
              <span className="text-[11px] text-white/50">ms 대기</span>
            </div>
          ) : (
            <>
              <input value={sigTopic} onChange={(e) => setSigTopic(e.target.value)} placeholder="신호 토픽 (로봇별은 {robot})" className={INP} />
              <input value={sigField} onChange={(e) => setSigField(e.target.value)} placeholder="필드 (빈값=수신만으로 완료)" className={INP} />
              <input value={sigValue} onChange={(e) => setSigValue(e.target.value)} placeholder="기대값 (예: true). 빈값=truthy" className={INP} />
            </>
          )}
        </div>
      )}

      {/* 완료 신호(외부 토픽 대기) — 종류 무관 공통. 기본 완료(도착/응답/result/발행) 후 이 외부 토픽 신호가
          와야 다음 스텝으로. '응답 검증'(이 호출의 응답)과 달리 외부 토픽을 비동기로 기다린다.
          대기(wait) 스텝은 그 자체가 신호 대기라 제외. */}
      {kind !== "wait" && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-1.5 flex flex-col gap-1.5">
          <button onClick={() => setEndOn((v) => !v)} className="flex items-center justify-between text-[10px] font-bold text-emerald-700">
            <span>🏁 완료 신호 <span className="text-white/35 font-normal">외부 토픽 대기 · 올 때까지 진행 보류</span></span>
            <span className={`px-1.5 py-0.5 rounded ${endOn ? "bg-emerald-500/30 text-emerald-50" : "bg-white/10 text-white/40"}`}>{endOn ? "ON" : "OFF"}</span>
          </button>
          {endOn && (<>
            <input value={endTopic} onChange={(e) => setEndTopic(e.target.value)} placeholder="외부 신호 토픽 (로봇별 {robot}, 예: /omx/vision/is_loaded)" className={INP} />
            <input value={endField} onChange={(e) => setEndField(e.target.value)} placeholder="필드 (빈값=수신만으로 완료)" className={INP} />
            <input value={endValue} onChange={(e) => setEndValue(e.target.value)} placeholder="기대값 (예: true). 빈값=truthy" className={INP} />
          </>)}
        </div>
      )}

      {serr && <span className="text-[10px] text-rose-500 font-bold">{serr}</span>}
      <button onClick={add} className="w-full py-1.5 text-[11px] font-extrabold rounded-lg bg-violet-500 text-paper hover:bg-violet-600">＋ 스텝 추가</button>

      <div className="flex flex-col gap-1 max-h-[150px] overflow-y-auto">
        {steps.length === 0 ? <div className="text-[10px] text-white/40 px-1 py-0.5">스텝 없음 (유형+목적지로 실행)</div>
          : steps.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.07] border border-white/[0.1]">
              <span className="text-[9px] font-extrabold text-white/40 w-3 text-center flex-none">{i + 1}</span>
              <span className={`w-2 h-2 rounded-full flex-none ${KIND_DOT[s.kind] ?? "bg-white/30"}`} />
              <span className="text-[10px] font-bold text-white/60 flex-none w-9">{KIND_KO[s.kind] ?? s.kind}</span>
              <span className="font-mono text-[10px] text-white/80 truncate flex-1">
                {s.kind === "move" ? `→ ${s.awaitNodeId}`
                  : s.kind === "wait" ? (s.awaitKind === "signal" ? `⟳ ${s.awaitTopic}${s.awaitField ? ` ${s.awaitField}=${String(s.awaitValue)}` : ""}` : `${s.waitMs}ms`)
                  : `${s.topicName.replace(`/${PH}/`, "")}${s.awaitField ? ` ⇒${s.awaitField}=${String(s.awaitValue)}` : ""}`}
                {s.endTopic ? <span className="text-emerald-600"> 🏁{s.endField ? `${s.endField}=${String(s.endValue)}` : s.endTopic}</span> : null}
              </span>
              <button onClick={() => setSteps((x) => x.filter((_, idx) => idx !== i))} className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/40 hover:text-rose-500 text-[11px] leading-none">✕</button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── 저장된 태스크 — 테스트(실행) / 삭제 ────────────────────────────────────
function SavedTasks({ defs, onRun, onDelete }: { defs: TaskDef[]; onRun: (id: string, name: string) => void; onDelete: (id: string) => void }) {
  return (
    <Panel title="저장된 태스크" hint={`${defs.length}개 · 테스트`}>
      {defs.length === 0 ? <div className="text-[11px] text-white/40 px-1 py-6 text-center">저장된 태스크가 없습니다 — 왼쪽에서 만들어 저장하세요</div>
        : defs.map((d) => (
          <div key={d._id} className="rounded-xl border border-white/[0.1] bg-white/[0.04] p-2.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-extrabold text-white truncate flex-1">{d.name}</span>
              <span className="text-[9px] text-white/40 flex-none">{d.steps?.length ?? 0}스텝</span>
              <button onClick={() => onDelete(d._id)} className="flex-none w-5 h-5 flex items-center justify-center rounded text-white/40 hover:text-rose-500 text-[11px]">✕</button>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-white/55">
              <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-paper font-bold ${prioDot(d.priority)}`}>{prioKo(d.priority)}</span>
              {d.repeat && <span className="px-1.5 py-0.5 rounded bg-amber-400 text-paper font-bold">🔁 반복</span>}
              {d.triggerTopic && <span className="px-1.5 py-0.5 rounded bg-sky-400 text-paper font-bold" title={`${d.triggerTopic}${d.triggerField ? ` ${d.triggerField}=${String(d.triggerValue)}` : ""}`}>⚡ 자동</span>}
              <span className="flex items-center gap-0.5">{d.preferredRobotId ? <>{robotIcon(d.preferredRobotId)}{d.preferredRobotId}</> : <span className="text-amber-600">🎯 추천 자동</span>}</span>
            </div>
            {d.steps && d.steps.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {d.steps.map((s, i) => (
                  <span key={i} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/[0.07] border border-white/[0.08] text-[9px] text-white/70">
                    <span className="text-amber-500 font-bold">{i + 1}</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${KIND_DOT[s.kind] ?? "bg-white/30"}`} />
                    {KIND_KO[s.kind] ?? s.kind}
                  </span>
                ))}
              </div>
            )}
            <button onClick={() => onRun(d._id, d.name)} className="w-full py-1.5 text-[11px] font-extrabold rounded-lg bg-emerald-500 text-paper hover:bg-emerald-600 transition-colors">▶ 테스트 실행</button>
          </div>
        ))}
    </Panel>
  );
}
