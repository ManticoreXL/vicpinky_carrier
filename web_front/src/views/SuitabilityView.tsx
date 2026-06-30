import { useState, useEffect, useMemo } from "react";
import type { RosMessage, FmsTask, FmsDispatchPayload, RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { ROBOTS } from "./taskmanager/constants";
import { robotPositions } from "../utils/robotPositions";
import { type RankedRobot, fetchRobotRanking } from "../utils/robotRanking";
import { taskTypeKo, taskStatusKo } from "../utils/statusLabel";
import TopologyMapView from "../components/TopologyMapView";

// 태스크가 주어졌을 때 어떤 로봇이 적합한지 판단하는 탭. 추천 순위는 백엔드(robot-priority) 단일 계산을 조회해 표시만 한다.
interface TopoNode { node_id: string; x: number; y: number; type: string; }

// 적합도 판정 대상은 이동형 태스크만 (충전=autoCharge, 공급=omx 전용이라 제외)
type SuitType = "MOVE" | "PROCESS";
const TASK_LABELS: Record<SuitType, string> = { MOVE: "이동", PROCESS: "구호" };
const TASK_PRIORITY: Record<SuitType, number> = { MOVE: 2, PROCESS: 3 };

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  robots: RobotInfo[];
  robotStatuses: Record<string, string>;
  emitFmsDispatch: (p: FmsDispatchPayload) => void;
  emitFmsRegister: (p: FmsDispatchPayload) => void;
}

export default function SuitabilityView({ rosMessages, fmsTasks, robots, robotStatuses, emitFmsDispatch, emitFmsRegister }: Props) {
  const [availableMaps, setAvailableMaps] = useState<string[]>([]);
  const [selectedMap, setSelectedMap] = useState("");
  const [topoNodes, setTopoNodes] = useState<TopoNode[]>([]);
  const [type, setType] = useState<SuitType>("MOVE");
  const [targetNode, setTargetNode] = useState("");
  const [registerMsg, setRegisterMsg] = useState<string | null>(null);
  const [batInputs, setBatInputs] = useState<Record<string, number>>({});
  const [errInputs, setErrInputs] = useState<Record<string, boolean>>({});

  // 추천 랭킹(robot-priority)은 백엔드 단일 계산 — 목적지/유형으로 조회하고 2초마다 갱신(배터리·상태 반영).
  const [ranking, setRanking] = useState<RankedRobot[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { void fetchRobotRanking(targetNode, type).then((d) => { if (alive) setRanking(d); }); };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [targetNode, type]);

  // 맵 목록 로드 + 기본 맵 선택 (할당된 맵 우선, 없으면 첫 맵)
  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND_URL}/api/map/static/list`).then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]),
      fetch(`${BACKEND_URL}/api/map/assignments`).then((r) => r.json() as Promise<Record<string, string>>).catch(() => ({})),
    ]).then(([list, asgn]) => {
      setAvailableMaps(list);
      setSelectedMap((prev) => prev || Object.values(asgn)[0] || list[0] || "");
    });
  }, []);

  // 선택된 맵의 노드 로드 (맵이 바뀌면 목적지도 초기화)
  useEffect(() => {
    setTargetNode("");
    if (!selectedMap) { setTopoNodes([]); return; }
    fetch(`${BACKEND_URL}/api/fleet/topology/nodes?map_id=${selectedMap}`)
      .then((r) => r.json())
      .then((ns: TopoNode[]) => setTopoNodes(Array.isArray(ns) ? ns : []))
      .catch(() => setTopoNodes([]));
  }, [selectedMap]);

  // ── 테스트봇 배터리 (임시 수동 설정) ──────────────────────────────────────
  const testBots = useMemo(() => ROBOTS.filter((r) => r.id.startsWith("TEST")).map((r) => r.id), []);
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
  // 적재 신호 — SUPPLY 적재 검증 대기 중인 테스트봇에 is_loaded=true 1회 발행(누르면 그 보급 완료). 1회성이라 토글 아님.
  const [loadedMsg, setLoadedMsg] = useState<string | null>(null);
  const applyLoaded = (robotId: string) => {
    fetch(`${BACKEND_URL}/api/test-robot/loaded`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotId }),
    }).catch(() => {});
    setLoadedMsg(robotId);
    setTimeout(() => setLoadedMsg((m) => (m === robotId ? null : m)), 1500);
  };

  const robotIds = useMemo(() => ROBOTS.map((r) => r.id), []);
  const positions = useMemo(() => robotPositions(rosMessages, robotIds), [rosMessages, robotIds]);
  // 최적 추천 = 백엔드 랭킹에서 가용(온라인·비오류) 1순위
  const topPick = useMemo(() => ranking.find((r) => r.online && !r.error) ?? null, [ranking]);

  // ── 태스크 패널 데이터 ────────────────────────────────────────────────────
  // 글로벌 태스크 큐: 아직 로봇에 배정 안 된 대기열 (등록/대기), 우선순위순
  const globalQueue = useMemo(
    () => fmsTasks.filter((t) => t.status === "DRAFT" || t.status === "PENDING").sort((a, b) => a.priority - b.priority),
    [fmsTasks],
  );
  // 로봇별 할당 태스크: assignedRobotId가 있고 진행/배정 상태 (진행 우선, 그다음 우선순위)
  const byRobot = useMemo(() => {
    const m: Record<string, FmsTask[]> = {};
    for (const t of fmsTasks) {
      if (t.assignedRobotId && (t.status === "ASSIGNED" || t.status === "RUNNING")) (m[t.assignedRobotId] ??= []).push(t);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => Number(b.status === "RUNNING") - Number(a.status === "RUNNING") || a.priority - b.priority);
    return m;
  }, [fmsTasks]);

  const canRegister = !!targetNode;
  const dispatch = (robotId: string) => {
    if (!targetNode) return;
    emitFmsDispatch({ type, targetNode, preferredRobotId: robotId, priority: TASK_PRIORITY[type] });
  };
  // 태스크 1개 등록(DRAFT) — 추천 1순위를 선호 로봇으로 (없으면 자동)
  const register = () => {
    if (!targetNode) return;
    emitFmsRegister({ type, targetNode, priority: TASK_PRIORITY[type], preferredRobotId: topPick?.robotId ?? undefined });
    setRegisterMsg(`✓ 등록 요청 보냄${topPick ? ` → ${topPick.robotId}` : ""}`);
    setTimeout(() => setRegisterMsg(null), 2500);
  };

  // 글로벌 큐 초기화 — 미배정 대기(PENDING/DRAFT) 일괄 삭제. 백엔드가 fms_tasks 재브로드캐스트.
  const clearQueue = () => {
    if (globalQueue.length === 0) return;
    fetch(`${BACKEND_URL}/api/fms/queue`, { method: "DELETE" }).catch(() => {});
  };

  return (
    <div className="flex flex-col lg:flex-row h-full bg-[#FFCE99]/32 overflow-hidden">
      {/* ── 좌: 태스크 조건 + 테스트봇 배터리 ── */}
      <aside className="w-full lg:w-80 flex-none border-r border-white/[0.1] p-6 space-y-5 overflow-y-auto">
        <div>
          <span className="sub-label">적합 로봇 판정</span>
          <h2 className="text-lg font-semibold text-white/90 tracking-wide mt-1">태스크 조건</h2>
          <p className="text-[11px] text-white/[0.5] mt-1 leading-relaxed">맵·목적지를 정의하면 가용성·배터리·근접도로 적합한 로봇을 순위화하고, 태스크를 등록합니다.</p>
        </div>

        {/* 맵 ID */}
        <div>
          <span className="sub-label">맵 ID</span>
          <select value={selectedMap} onChange={(e) => setSelectedMap(e.target.value)}
            className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none">
            {availableMaps.length === 0 && <option value="">맵 없음</option>}
            {availableMaps.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        {/* 태스크 유형 (이동·구호) */}
        <div>
          <span className="sub-label">태스크 유형</span>
          <div className="grid grid-cols-2 gap-1 mt-1">
            {(Object.keys(TASK_LABELS) as SuitType[]).map((t) => (
              <button key={t} onClick={() => setType(t)}
                className={`py-1.5 text-xs font-bold tracking-wide rounded border transition-all ${type === t ? "bg-sky-600/40 text-sky-800 border-sky-500/60" : "bg-[#FFCE99]/32 text-white/[0.55] border-white/[0.1] hover:text-white/[0.75]"}`}>
                {TASK_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* 목적지 노드 */}
        <div>
          <span className="sub-label">목적지 노드 ({topoNodes.length})</span>
          <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}
            className="w-full mt-1 bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-white/85 focus:outline-none">
            <option value="">목적지 노드 선택…</option>
            {topoNodes.map((n) => <option key={n.node_id} value={n.node_id}>{n.node_id} ({n.type})</option>)}
          </select>
          <p className="text-[10px] text-white/[0.4] mt-1">목적지를 고르면 근접도 점수가 반영되고 지도에 강조됩니다.</p>
        </div>

        {/* 태스크 등록 (DRAFT) */}
        <button onClick={register} disabled={!canRegister}
          className="w-full py-2.5 text-xs font-bold tracking-wide rounded-xl border border-violet-500/50 bg-violet-600/30 text-violet-100 hover:bg-violet-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
          {registerMsg ?? `태스크 등록${topPick ? ` (→ ${topPick.robotId})` : ""}`}
        </button>

        {topPick && (
          <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10">
            <div className="text-[10px] text-amber-700 font-bold tracking-widest uppercase">최적 추천</div>
            <div className="text-lg font-bold font-mono text-amber-800 mt-0.5">⭐ {topPick.robotId}</div>
            <div className="text-[11px] text-white/[0.6] mt-0.5">
              #{topPick.rank} · {topPick.busy ? "작업 중" : "대기 중"}
              {topPick.distance != null ? ` · ${topPick.distance.toFixed(1)}m` : ""}
              {topPick.batteryPct != null ? ` · ${topPick.batteryPct}%` : ""}
            </div>
          </div>
        )}

        {/* 테스트봇 배터리 임시 설정 */}
        {testBots.length > 0 && (
          <div className="pt-1 border-t border-white/[0.08]">
            <span className="sub-label">테스트봇 제어 <span className="text-white/[0.4] normal-case">(임시 · 배터리 슬라이드 · 전복 · 적재 신호)</span></span>
            <div className="space-y-2 mt-2">
              {testBots.map((id) => {
                const val = batInputs[id] ?? 100;
                const err = errInputs[id] ?? false;
                return (
                  <div key={id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-white/[0.6] w-[72px] truncate">{id}</span>
                      <input type="range" min={0} max={100} value={val} disabled={err}
                        onChange={(e) => setBatInputs((p) => ({ ...p, [id]: +e.target.value }))}
                        onPointerUp={() => applyBattery(id, batInputs[id] ?? val)}
                        onTouchEnd={() => applyBattery(id, batInputs[id] ?? val)}
                        className="flex-1 accent-emerald-500 disabled:opacity-40" />
                      <span className={`font-mono text-[10px] w-8 text-right ${val < 20 ? "text-rose-500" : "text-white/[0.7]"}`}>{val}%</span>
                    </div>
                    <div className="flex items-center gap-3 pl-[80px]">
                      <label className={`flex items-center gap-1 text-[10px] font-bold cursor-pointer select-none ${err ? "text-rose-500" : "text-white/[0.45] hover:text-white/[0.7]"}`} title="전복(ERROR) 시뮬레이션">
                        <input type="checkbox" checked={err} onChange={(e) => applyError(id, e.target.checked)} className="accent-rose-500" />
                        ⚠ 에러
                      </label>
                      <button onClick={() => applyLoaded(id)} title="SUPPLY 적재 완료 신호 — 이 봇이 보급 적재 대기 중일 때 누르면 완료 처리"
                        className="flex items-center gap-1 text-[10px] font-bold text-emerald-700 hover:text-emerald-600 transition-colors">
                        📦 {loadedMsg === id ? "신호 보냄!" : "적재 신호"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {/* ── 중: 순위 + 태스크 큐 ── */}
      <main className="flex-1 overflow-y-auto p-6 min-w-0 space-y-6">
        {/* 적합 로봇 순위 */}
        <div className="space-y-2.5">
          {ranking.length === 0 && <p className="text-[11px] text-white/[0.4]">추천할 로봇이 없습니다 (목적지를 선택하세요).</p>}
          {ranking.map((r, i) => {
            const selectable = r.online && !r.error;
            const isTop = topPick?.robotId === r.robotId;
            const statusLabel = r.error ? "오류" : !r.online ? "오프라인" : r.busy ? "작업 중" : "대기 중";
            return (
              <div key={r.robotId}
                className={`rounded-xl border p-4 transition-all ${
                  isTop ? "bg-amber-500/10 border-amber-500/40"
                  : selectable ? "bg-[#FFCE99]/32 border-white/[0.12]"
                  : "bg-transparent border-white/[0.06] opacity-50"
                }`}>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold w-6 text-center flex-none ${isTop ? "text-amber-600" : "text-white/[0.4]"}`}>{isTop ? "⭐" : selectable ? i + 1 : "—"}</span>
                  <span className="font-mono font-bold text-white/90 text-sm w-28 flex-none">{r.robotId}</span>
                  <span className="text-[11px] text-white/[0.6] flex-1 truncate">{statusLabel}{r.distance != null ? ` · ${r.distance.toFixed(1)}m` : ""}</span>
                  {r.batteryPct != null && <span className={`text-[11px] font-mono flex-none ${r.batteryPct < 20 ? "text-rose-600" : "text-white/[0.55]"}`}>{r.batteryPct}%</span>}
                  <button onClick={() => dispatch(r.robotId)} disabled={!selectable || !canRegister}
                    className="flex-none px-3 py-1 text-[11px] font-bold rounded-lg border border-sky-500/50 bg-sky-600/30 text-sky-100 hover:bg-sky-600/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                    할당
                  </button>
                </div>
                {selectable && r.batteryPct != null && (
                  <div className="flex items-center gap-1 mt-2 h-1.5" title={`배터리 ${r.batteryPct}%`}>
                    <div className="flex-1 h-1.5 bg-[#FFCE99]/40 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${r.batteryPct}%` }} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 글로벌 태스크 큐 */}
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <div className="flex items-baseline gap-2">
              <span className="sub-label !mb-0">글로벌 태스크 큐</span>
              <span className="text-[11px] text-white/[0.45] font-mono">{globalQueue.length}</span>
            </div>
            <button onClick={clearQueue} disabled={globalQueue.length === 0}
              className="text-[10px] font-bold px-2 py-0.5 rounded border border-rose-500/40 text-rose-300 bg-rose-600/20 hover:bg-rose-600/40 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
              초기화
            </button>
          </div>
          {globalQueue.length === 0 ? (
            <p className="text-[11px] text-white/[0.4]">대기 중인 태스크 없음</p>
          ) : (
            <div className="space-y-1.5">
              {globalQueue.map((t) => (
                <div key={t._id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.1] bg-[#FFCE99]/20 text-[11px]">
                  <span className="font-mono font-bold text-white/[0.5] w-6 text-center flex-none" title="우선순위">P{t.priority}</span>
                  <span className="font-semibold text-white/85 w-10 flex-none">{taskTypeKo(t.type)}</span>
                  <span className="font-mono text-white/[0.7] flex-1 truncate">→ {t.targetNode}</span>
                  {t.preferredRobotId && <span className="font-mono text-sky-700 flex-none">{t.preferredRobotId}</span>}
                  <span className="text-white/[0.55] flex-none">{taskStatusKo(t.status)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 로봇별 할당 태스크 */}
        <section>
          <span className="sub-label">로봇별 할당 태스크</span>
          {Object.keys(byRobot).length === 0 ? (
            <p className="text-[11px] text-white/[0.4] mt-1">진행 중인 배정 없음</p>
          ) : (
            <div className="space-y-2 mt-1">
              {Object.entries(byRobot).map(([robotId, tasks]) => (
                <div key={robotId} className="rounded-xl border border-white/[0.1] bg-[#FFCE99]/20 p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-mono font-bold text-white/90 text-xs">{robotId}</span>
                    <span className="text-[10px] text-white/[0.45]">{tasks.length}건</span>
                  </div>
                  <div className="space-y-1">
                    {tasks.map((t) => (
                      <div key={t._id} className="flex items-center gap-2 text-[11px]">
                        <span className={`w-1.5 h-1.5 rounded-full flex-none ${t.status === "RUNNING" ? "bg-sky-400 animate-pulse" : "bg-amber-400"}`} />
                        <span className="font-semibold text-white/80 w-10 flex-none">{taskTypeKo(t.type)}</span>
                        <span className="font-mono text-white/[0.65] flex-1 truncate">→ {t.targetNode}</span>
                        <span className="text-white/[0.5] flex-none">{taskStatusKo(t.status)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* ── 우: 지도 + 로봇 현재 위치 ── */}
      <div className="w-full lg:w-[40%] flex-none border-t lg:border-t-0 lg:border-l border-white/[0.1] p-4 flex flex-col min-h-[340px]">
        <div className="flex items-baseline justify-between mb-2">
          <span className="sub-label !mb-0">현재 위치 지도</span>
          <span className="text-[11px] text-white/[0.5] font-mono">{selectedMap || "맵 미선택"}</span>
        </div>
        <div className="flex-1 min-h-0">
          <TopologyMapView
            mapId={selectedMap}
            robotPositions={positions}
            highlightNodeId={targetNode || null}
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}
