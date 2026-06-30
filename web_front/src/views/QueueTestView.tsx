import { useState, useMemo, useCallback } from "react";
import type { RosMessage, FmsTask, FmsDispatchPayload, TaskType, RobotInfo } from "../hooks/useNestSocket";
import { ROBOTS } from "./taskmanager/constants";
import { taskTypeKo, taskStatusKo, robotStatusKo, robotStatusColor } from "../utils/statusLabel";
import { useTopoNodes } from "../hooks/useTopoNodes";

// 테스트/이벤트 탭 — 일(태스크)을 배치(주입)하고, 글로벌 큐 스택 + 로봇별 큐 스택이 쌓이는 것을 본다.
// 테스트뿐 아니라 실제 이벤트 주입 지점으로도 쓰인다(태스크 발행 = 이벤트 발생).

const TASK_LABELS: Record<TaskType, string> = { SUPPLY: "공급", PROCESS: "구호", CHARGE: "충전", MOVE: "이동", RECALL: "복귀", PAUSE: "일시정지" };
const SUPPLY_ITEMS = ["물", "약"] as const;
const ACTIVE_TASK = ["PENDING", "ASSIGNED", "RUNNING", "SUSPENDED"];

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  robots: RobotInfo[];
  robotStatuses: Record<string, string>;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsRegister: (p: FmsDispatchPayload) => void;
  emitFmsAutoCharge: (robotId: string) => void;
}

export default function QueueTestView({ fmsTasks, robots, robotStatuses, emitFmsDispatch, emitFmsRegister, emitFmsAutoCharge }: Props) {
  const topoNodes = useTopoNodes();
  const [type, setType] = useState<TaskType>("MOVE");
  const [targetNode, setTargetNode] = useState("");      // "" = 랜덤
  const [preferredRobotId, setPreferredRobotId] = useState(""); // "" = 자동 배정
  const [supplyItem, setSupplyItem] = useState<typeof SUPPLY_ITEMS[number]>("물");
  const [count, setCount] = useState(5);
  const [register, setRegister] = useState(false);       // true = 등록만(DRAFT, 자동할당 X)

  const isSupply = type === "SUPPLY";
  const isCharge = type === "CHARGE";
  const moveNodes = useMemo(() => topoNodes.filter((n) => isCharge ? n.type === "CHARGER" : n.type !== "CHARGER"), [topoNodes, isCharge]);

  // pseudo-random index (Math.random 사용 가능 — 프론트)
  const pickTarget = useCallback(() => {
    if (targetNode) return targetNode;
    if (!moveNodes.length) return "";
    return moveNodes[Math.floor(Math.random() * moveNodes.length)].node_id;
  }, [targetNode, moveNodes]);

  // ── 일 배치(주입) ────────────────────────────────────────────────────────────
  const inject = useCallback(() => {
    const emit = register ? emitFmsRegister : emitFmsDispatch;
    for (let i = 0; i < count; i++) {
      if (isCharge) {
        // 충전은 로봇 지정 필요 — 지정 로봇 or 온라인 로봇 순회
        const rid = preferredRobotId || ROBOTS[i % ROBOTS.length].id;
        emitFmsAutoCharge(rid);
        continue;
      }
      if (isSupply) {
        emit({ type: "SUPPLY", targetNode: supplyItem, priority: 1, preferredRobotId: "omx" });
        continue;
      }
      const t = pickTarget();
      if (!t) break;
      emit({ type, targetNode: t, priority: type === "PROCESS" ? 3 : 5, preferredRobotId: preferredRobotId || undefined });
    }
  }, [register, count, isCharge, isSupply, supplyItem, type, preferredRobotId, pickTarget, emitFmsDispatch, emitFmsRegister, emitFmsAutoCharge]);

  // ── 큐 카테고리화 (글로벌 / 로봇별) ──────────────────────────────────────────
  const { global, byRobot } = useMemo(() => {
    const global: FmsTask[] = [];
    const byRobot: Record<string, FmsTask[]> = {};
    for (const t of fmsTasks) {
      if (!ACTIVE_TASK.includes(t.status)) continue;
      const owner = t.assignedRobotId || (t.status === "PENDING" || t.status === "DRAFT" ? t.preferredRobotId : null);
      if (owner) (byRobot[owner] ??= []).push(t);
      else global.push(t);   // 미배정 PENDING/DRAFT → 글로벌 큐
    }
    // 글로벌: 우선순위 → 생성순
    global.sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return { global, byRobot };
  }, [fmsTasks]);

  // 로봇별 큐가 있거나 온라인인 로봇만 컬럼 표시
  const robotCols = useMemo(() => ROBOTS.filter((r) => (byRobot[r.id]?.length ?? 0) > 0 || robotStatuses[r.id]), [byRobot, robotStatuses]);

  return (
    <div className="flex flex-col md:flex-row h-full bg-[#FFCE99]/32 overflow-hidden min-h-0">
      {/* ── 좌: 일 배치 / 이벤트 주입 ── */}
      <aside className="w-full md:w-72 flex-none border-b md:border-b-0 md:border-r border-white/[0.1] p-5 space-y-4 overflow-y-auto max-h-[50vh] md:max-h-none">
        <div>
          <span className="sub-label">테스트 / 이벤트 주입</span>
          <h2 className="text-base font-semibold text-white/90 tracking-wide mt-1">작업 배치</h2>
          <p className="text-[11px] text-white/[0.5] mt-1 leading-relaxed">태스크를 배치하면 글로벌 큐에 쌓였다가 로봇별 큐로 분배됩니다. 실제 이벤트 주입 지점이기도 합니다.</p>
        </div>

        <div>
          <span className="sub-label">유형</span>
          <div className="grid grid-cols-4 gap-1 mt-1">
            {(Object.keys(TASK_LABELS) as TaskType[]).map((t) => (
              <button key={t} onClick={() => { setType(t); setTargetNode(""); }}
                className={`py-1 text-[10px] font-bold rounded border transition-all ${type === t ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1]"}`}>
                {TASK_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {isSupply ? (
          <div>
            <span className="sub-label">보급 품목</span>
            <div className="grid grid-cols-2 gap-1 mt-1">
              {SUPPLY_ITEMS.map((item) => (
                <button key={item} onClick={() => setSupplyItem(item)}
                  className={`py-1.5 text-xs font-bold rounded border ${supplyItem === item ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.6] border-white/[0.1]"}`}>
                  {item === "물" ? "💧 물" : "💊 약"}
                </button>
              ))}
            </div>
          </div>
        ) : isCharge ? (
          <p className="text-[11px] text-emerald-700 bg-emerald-600/10 border border-emerald-500/30 rounded-lg px-3 py-2">⚡ 충전소는 백엔드 자동 선택. 지정 로봇(또는 순회)으로 자동충전 요청을 주입합니다.</p>
        ) : (
          <div>
            <span className="sub-label">목적지 (빈칸 = 랜덤)</span>
            <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}
              className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none">
              <option value="">🎲 랜덤</option>
              {moveNodes.map((n) => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.type})</option>)}
            </select>
          </div>
        )}

        {!isSupply && (
          <div>
            <span className="sub-label">{isCharge ? "충전 로봇 (빈칸=순회)" : "지정 로봇 (빈칸=자동 배정)"}</span>
            <select value={preferredRobotId} onChange={(e) => setPreferredRobotId(e.target.value)}
              className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/75 focus:outline-none">
              <option value="">{isCharge ? "전체 순회" : "자동 배정"}</option>
              {ROBOTS.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </div>
        )}

        <div>
          <span className="sub-label">배치 개수</span>
          <div className="flex items-center gap-2 mt-1">
            <input type="range" min={1} max={30} value={count} onChange={(e) => setCount(+e.target.value)} className="flex-1 accent-sky-500" />
            <span className="text-xs font-bold text-white/80 font-mono w-7 text-center">{count}</span>
          </div>
        </div>

        {!isCharge && (
          <label className="flex items-center gap-2 text-[11px] text-white/[0.6] cursor-pointer">
            <input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} className="accent-violet-500" />
            등록만 (DRAFT — 자동할당 안 함)
          </label>
        )}

        <button onClick={inject}
          className="w-full glass-button !bg-sky-600 hover:!bg-sky-500 !text-sm !font-bold !tracking-wide !py-2.5 !rounded-xl shadow-xl">
          ▶ {count}건 배치
        </button>
      </aside>

      {/* ── 우: 큐 스택 (칸반) ── */}
      <main className="flex-1 overflow-x-auto p-4">
        <div className="flex gap-3 h-full min-w-max">
          {/* 글로벌 큐 */}
          <QueueColumn title="글로벌 큐" sub="미배정 (할당 대기)" count={global.length} accent="border-amber-500/50 bg-amber-500/8">
            {global.map((t) => <TaskChip key={t._id} task={t} />)}
            {global.length === 0 && <Empty text="대기 작업 없음" />}
          </QueueColumn>

          {/* 로봇별 큐 */}
          {robotCols.map((r) => {
            const list = byRobot[r.id] ?? [];
            const active = list.filter((t) => ["ASSIGNED", "RUNNING"].includes(t.status) && t.assignedRobotId === r.id && !(t.waitReason ?? "").includes("대기열"));
            const queued = list.filter((t) => !active.includes(t));
            const st = robotStatuses[r.id];
            return (
              <QueueColumn key={r.id} title={r.id} sub={st ? robotStatusKo(st) : "—"} subColor={robotStatusColor(st)} count={list.length} accent="border-white/[0.12] bg-[#FFCE99]/14">
                {active.map((t) => <TaskChip key={t._id} task={t} active />)}
                {queued.length > 0 && <div className="text-[9px] font-bold tracking-widest text-white/[0.4] uppercase mt-1 mb-0.5">대기 스택 {queued.length}</div>}
                {queued.map((t, i) => <TaskChip key={t._id} task={t} order={i + 1} />)}
                {list.length === 0 && <Empty text="없음" />}
              </QueueColumn>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function QueueColumn({ title, sub, subColor, count, accent, children }: { title: string; sub: string; subColor?: string; count: number; accent: string; children: React.ReactNode }) {
  return (
    <div className={`w-52 flex-none flex flex-col rounded-xl border ${accent}`}>
      <div className="flex-none px-3 py-2 border-b border-white/[0.1]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold font-mono text-white/90 truncate">{title}</span>
          <span className="text-[10px] font-bold text-white/[0.55] bg-[#FFCE99]/40 rounded px-1.5">{count}</span>
        </div>
        <div className={`text-[10px] ${subColor ?? "text-white/[0.5]"}`}>{sub}</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">{children}</div>
    </div>
  );
}

function TaskChip({ task, active, order }: { task: FmsTask; active?: boolean; order?: number }) {
  return (
    <div className={`rounded-lg border px-2 py-1.5 text-[11px] ${active ? "bg-emerald-600/15 border-emerald-500/40" : "bg-[#FFCE99]/32 border-white/[0.1]"}`}>
      <div className="flex items-center gap-1.5">
        {order != null && <span className="text-[9px] font-bold text-white/[0.4] w-3 text-center flex-none">{order}</span>}
        {active && <span className="text-[8px] font-bold text-emerald-600 flex-none">▶</span>}
        <span className="font-bold text-white/85 flex-none">{taskTypeKo(task.type)}</span>
        <span className="text-white/[0.55] truncate flex-1">→ {task.targetNode}</span>
        <span className="text-[9px] text-white/[0.45] flex-none">P{task.priority}</span>
      </div>
      <div className="text-[9px] text-white/[0.4] mt-0.5">{taskStatusKo(task.status)}{task.waitReason ? ` · ${task.waitReason}` : ""}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-center text-[10px] text-white/[0.35] italic py-4">{text}</div>;
}
