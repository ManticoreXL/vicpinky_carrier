import { useState, useEffect, useMemo, useCallback } from "react";
import type { RosMessage, FmsTask, FmsDispatchPayload, RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { ROBOTS } from "./taskmanager/constants";
import { robotPositions } from "../utils/robotPositions";
import { taskTypeKo, taskStatusKo, robotStatusKo, robotStatusColor } from "../utils/statusLabel";
import TopologyMapView from "../components/TopologyMapView";

// 테스트 탭 — 테스트봇(가상) 상태·작업 관리.
// 각 테스트봇 카드: 상태(배터리/전복/적재 컨트롤) + 현재·대기 작업 + 작업 배치(dispatch).
// (추천 랭킹은 별도 백엔드 계산이라 여기선 제외 — 여긴 테스트봇 조작 전용.)
interface TopoNode { node_id: string; x: number; y: number; type: string; }

type DispType = "MOVE" | "PROCESS";
const TASK_LABELS: Record<DispType, string> = { MOVE: "이동", PROCESS: "구호" };
const TASK_PRIORITY: Record<DispType, number> = { MOVE: 2, PROCESS: 3 };
const ACTIVE = ["PENDING", "ASSIGNED", "RUNNING", "SUSPENDED"];

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  robots: RobotInfo[];
  robotStatuses: Record<string, string>;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsRegister: (p: FmsDispatchPayload) => void;
}

export default function SuitabilityView({ rosMessages, fmsTasks, robotStatuses, emitFmsDispatch }: Props) {
  const [availableMaps, setAvailableMaps] = useState<string[]>([]);
  const [selectedMap, setSelectedMap] = useState("");
  const [topoNodes, setTopoNodes] = useState<TopoNode[]>([]);
  const [type, setType] = useState<DispType>("MOVE");
  const [targetNode, setTargetNode] = useState("");        // "" = 랜덤
  const [batInputs, setBatInputs] = useState<Record<string, number>>({});
  const [errInputs, setErrInputs] = useState<Record<string, boolean>>({});
  const [loadedMsg, setLoadedMsg] = useState<string | null>(null);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  const testBots = useMemo(() => ROBOTS.filter((r) => r.id.startsWith("TEST")).map((r) => r.id), []);
  const robotIds = useMemo(() => ROBOTS.map((r) => r.id), []);
  const positions = useMemo(() => robotPositions(rosMessages, robotIds), [rosMessages, robotIds]);
  const moveNodes = useMemo(() => topoNodes.filter((n) => n.type !== "CHARGER"), [topoNodes]);

  // ── 맵/노드 로드 ────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND_URL}/api/map/static/list`).then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]),
      fetch(`${BACKEND_URL}/api/map/assignments`).then((r) => r.json() as Promise<Record<string, string>>).catch(() => ({})),
    ]).then(([list, asgn]) => {
      setAvailableMaps(list);
      setSelectedMap((prev) => prev || Object.values(asgn)[0] || list[0] || "");
    });
  }, []);
  useEffect(() => {
    setTargetNode("");
    if (!selectedMap) { setTopoNodes([]); return; }
    fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${selectedMap}`)
      .then((r) => r.json())
      .then((ns: TopoNode[]) => setTopoNodes(Array.isArray(ns) ? ns : []))
      .catch(() => setTopoNodes([]));
  }, [selectedMap]);

  // ── 테스트봇 상태(배터리/전복) 로드 + 제어 ──────────────────────────────────
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/test-robot/battery`).then((r) => r.json())
      .then((list: { robotId: string; battery: number; error?: boolean }[]) => {
        setBatInputs(Object.fromEntries(list.map((b) => [b.robotId, b.battery])));
        setErrInputs(Object.fromEntries(list.map((b) => [b.robotId, !!b.error])));
      })
      .catch(() => {});
  }, []);
  const applyBattery = (robotId: string, pct: number) => {
    fetch(`${BACKEND_URL}/api/test-robot/battery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotId, percentage: pct }),
    }).catch(() => {});
  };
  const applyError = (robotId: string, error: boolean) => {
    setErrInputs((p) => ({ ...p, [robotId]: error }));
    fetch(`${BACKEND_URL}/api/test-robot/error`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotId, error }),
    }).catch(() => {});
  };
  // 적재 신호 — SUPPLY 적재 검증 대기 중인 테스트봇에 is_loaded=true 1회 발행(1회성).
  const applyLoaded = (robotId: string) => {
    fetch(`${BACKEND_URL}/api/test-robot/loaded`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotId }),
    }).catch(() => {});
    setLoadedMsg(robotId);
    setTimeout(() => setLoadedMsg((m) => (m === robotId ? null : m)), 1500);
  };

  // ── 테스트봇별 현재·대기 작업 ────────────────────────────────────────────────
  const byRobot = useMemo(() => {
    const m: Record<string, FmsTask[]> = {};
    for (const t of fmsTasks) {
      if (!ACTIVE.includes(t.status)) continue;
      const owner = t.assignedRobotId || (t.status === "PENDING" || t.status === "DRAFT" ? t.preferredRobotId : null);
      if (owner) (m[owner] ??= []).push(t);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => Number(b.status === "RUNNING") - Number(a.status === "RUNNING") || a.priority - b.priority);
    return m;
  }, [fmsTasks]);

  // ── 작업 배치 (좌측 설정 유형/목적지로 해당 테스트봇에 배정) ────────────────
  const pickTarget = useCallback(() => {
    if (targetNode) return targetNode;
    if (!moveNodes.length) return "";
    return moveNodes[Math.floor(Math.random() * moveNodes.length)].node_id;
  }, [targetNode, moveNodes]);
  const dispatch = (botId: string) => {
    const target = pickTarget();
    if (!target) return;
    emitFmsDispatch({ type, targetNode: target, priority: TASK_PRIORITY[type], preferredRobotId: botId });
    setSentMsg(botId);
    setTimeout(() => setSentMsg((m) => (m === botId ? null : m)), 1500);
  };

  return (
    <div className="flex flex-col lg:flex-row h-full bg-[#FFCE99]/32 overflow-hidden">
      {/* ── 좌: 작업 배치 설정 ── */}
      <aside className="w-full lg:w-72 flex-none border-r border-white/[0.1] p-5 space-y-5 overflow-y-auto">
        <div>
          <span className="sub-label">테스트봇 관리</span>
          <h2 className="text-lg font-semibold text-white/90 tracking-wide mt-1">작업 배치 설정</h2>
          <p className="text-[11px] text-white/[0.5] mt-1 leading-relaxed">아래 유형·목적지로 각 테스트봇 카드의 <b>배치</b> 버튼이 그 봇에게 작업을 배정합니다.</p>
        </div>

        <div>
          <span className="sub-label">맵 ID</span>
          <select value={selectedMap} onChange={(e) => setSelectedMap(e.target.value)}
            className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none">
            {availableMaps.length === 0 && <option value="">맵 없음</option>}
            {availableMaps.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <span className="sub-label">태스크 유형</span>
          <div className="grid grid-cols-2 gap-1 mt-1">
            {(Object.keys(TASK_LABELS) as DispType[]).map((t) => (
              <button key={t} onClick={() => setType(t)}
                className={`py-1.5 text-xs font-bold tracking-wide rounded border transition-all ${type === t ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1] hover:text-white/[0.75]"}`}>
                {TASK_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="sub-label">목적지 (빈칸 = 랜덤)</span>
          <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}
            className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none">
            <option value="">🎲 랜덤</option>
            {moveNodes.map((n) => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.type})</option>)}
          </select>
        </div>

        {/* 현재 위치 지도 */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="sub-label !mb-0">테스트봇 위치</span>
            <span className="text-[11px] text-white/[0.5] font-mono">{selectedMap || "맵 미선택"}</span>
          </div>
          <div className="h-56 rounded-lg overflow-hidden border border-white/[0.1]">
            <TopologyMapView mapId={selectedMap} robotPositions={positions} highlightNodeId={targetNode || null} className="h-full" />
          </div>
        </div>
      </aside>

      {/* ── 우: 테스트봇 카드 ── */}
      <main className="flex-1 overflow-y-auto p-6">
        {testBots.length === 0 ? (
          <p className="text-[12px] text-white/[0.4]">등록된 테스트봇이 없습니다.</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {testBots.map((id) => {
              const st = robotStatuses[id];
              const bat = batInputs[id] ?? 100;
              const err = errInputs[id] ?? false;
              const tasks = byRobot[id] ?? [];
              const running = tasks.filter((t) => t.status === "RUNNING" || t.status === "ASSIGNED");
              const queued = tasks.filter((t) => !running.includes(t));
              return (
                <div key={id} className={`rounded-xl border p-4 space-y-3 transition-all ${err ? "border-rose-500/40 bg-rose-600/8" : "border-white/[0.12] bg-[#FFCE99]/32"}`}>
                  {/* 헤더: id + 상태 + 배터리 */}
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-white/90 text-sm">{id}</span>
                    <span className={`text-[11px] font-semibold ${robotStatusColor(st)}`}>{st ? robotStatusKo(st) : "—"}</span>
                    <span className="flex-1" />
                    <span className={`text-[11px] font-mono font-bold ${bat < 20 ? "text-rose-500" : "text-white/[0.7]"}`}>{bat}%</span>
                  </div>

                  {/* 상태 제어: 배터리 / 전복 / 적재 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/[0.5] w-10 flex-none">배터리</span>
                      <input type="range" min={0} max={100} value={bat} disabled={err}
                        onChange={(e) => setBatInputs((p) => ({ ...p, [id]: +e.target.value }))}
                        onPointerUp={() => applyBattery(id, batInputs[id] ?? bat)}
                        onTouchEnd={() => applyBattery(id, batInputs[id] ?? bat)}
                        className="flex-1 accent-emerald-500 disabled:opacity-40" />
                    </div>
                    <div className="flex items-center gap-3">
                      <label className={`flex items-center gap-1 text-[10px] font-bold cursor-pointer select-none ${err ? "text-rose-500" : "text-white/[0.45] hover:text-white/[0.7]"}`} title="전복(ERROR) 시뮬레이션">
                        <input type="checkbox" checked={err} onChange={(e) => applyError(id, e.target.checked)} className="accent-rose-500" />
                        ⚠ 전복(에러)
                      </label>
                      <button onClick={() => applyLoaded(id)} title="SUPPLY 적재 완료 신호 — 이 봇이 보급 적재 대기 중일 때"
                        className="flex items-center gap-1 text-[10px] font-bold text-emerald-700 hover:text-emerald-600 transition-colors">
                        📦 {loadedMsg === id ? "신호 보냄!" : "적재 신호"}
                      </button>
                    </div>
                  </div>

                  {/* 현재·대기 작업 */}
                  <div className="border-t border-white/[0.08] pt-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-bold tracking-widest text-white/[0.4] uppercase">작업 {tasks.length}건</span>
                      <button onClick={() => dispatch(id)} disabled={err || !selectedMap}
                        className="px-3 py-1 text-[11px] font-bold rounded-lg border border-sky-500/50 bg-sky-600/30 text-sky-100 hover:bg-sky-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                        {sentMsg === id ? "배치됨!" : `▶ ${TASK_LABELS[type]} 배치`}
                      </button>
                    </div>
                    {tasks.length === 0 ? (
                      <p className="text-[10px] text-white/[0.35] italic py-1">작업 없음</p>
                    ) : (
                      <div className="space-y-1">
                        {running.map((t) => <TaskRow key={t._id} task={t} active />)}
                        {queued.length > 0 && <div className="text-[9px] font-bold tracking-widest text-white/[0.4] uppercase mt-1">대기 {queued.length}</div>}
                        {queued.map((t, i) => <TaskRow key={t._id} task={t} order={i + 1} />)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function TaskRow({ task, active, order }: { task: FmsTask; active?: boolean; order?: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {order != null && <span className="text-[9px] font-bold text-white/[0.4] w-3 text-center flex-none">{order}</span>}
      <span className={`w-1.5 h-1.5 rounded-full flex-none ${active ? "bg-sky-400 animate-pulse" : "bg-amber-400"}`} />
      <span className="font-semibold text-white/80 w-10 flex-none">{taskTypeKo(task.type)}</span>
      <span className="font-mono text-white/[0.65] flex-1 truncate">→ {task.targetNode}</span>
      <span className="text-white/[0.5] flex-none">{taskStatusKo(task.status)}</span>
    </div>
  );
}
