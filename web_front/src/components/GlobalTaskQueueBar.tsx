import { useState, useEffect, useMemo, useRef } from "react";
import type { FmsTask } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { type FNode, ymdLocal, toLocalDatetimeValue } from "./taskqueue/shared";
import { Dropdown } from "./taskqueue/Dropdown";
import { AddTaskPanel } from "./taskqueue/AddTaskPanel";
import { TaskMiniCard } from "./taskqueue/TaskMiniCard";
import { BatchCard } from "./taskqueue/BatchCard";
import { ScenarioCard } from "./taskqueue/ScenarioCard";

// TaskMiniCard 는 외부(TaskManagerView)가 이 경로로 import 하므로 재노출한다.
export { TaskMiniCard } from "./taskqueue/TaskMiniCard";

// 글로벌 태스크 큐 — 모든 뷰 상단에 가로로. 위: 타이틀/맵필터/정렬/추가, 아래: 태스크 상세 카드(가로 스크롤).
// (서브컴포넌트/공용 헬퍼는 components/taskqueue/* 로 분리됨.)

// 필터 상태를 모듈 레벨에 보관 — 흐름도/설정 등 큐바가 안 보이는 탭에 갔다 와도(언마운트→리마운트)
// 필터가 풀리지 않게 유지한다. (페이지 새로고침 시에만 초기화)
const qbFilters = { mapFilter: "", dateFilter: "", afterTime: "", liveNow: true, sortBy: "priority" as "recent" | "priority" };

// "지금" 라이브 기준 시각 = 현재-30분(최근 30분 창). 라이브 모드면 2초마다 이 값으로 갱신되어 창이 슬라이딩한다.
const LIVE_WINDOW_MS = 30 * 60 * 1000;
const nowAfterPreset = () => toLocalDatetimeValue(new Date(Date.now() - LIVE_WINDOW_MS));

export default function GlobalTaskQueueBar({ tasks }: { tasks: FmsTask[] }) {
  const [maps, setMaps] = useState<string[]>([]);
  const [nodes, setNodes] = useState<FNode[]>([]);
  const [robots, setRobots] = useState<string[]>([]);
  // 초기값을 모듈 캐시에서 — 탭 이동(언마운트) 후 돌아와도 마지막 필터 복원
  const [mapFilter, setMapFilter] = useState(qbFilters.mapFilter);
  const [dateFilter, setDateFilter] = useState(qbFilters.dateFilter); // 등록일(YYYY-MM-DD) — 빈값=전체
  const [liveNow, setLiveNow] = useState(qbFilters.liveNow); // "지금" 라이브 추종(최근 30분 슬라이딩) — 초기 활성
  const [afterTime, setAfterTime] = useState(qbFilters.liveNow ? nowAfterPreset() : qbFilters.afterTime); // 기준 시각(datetime-local) 이후 등록 태스크만 — liveNow면 (현재-30분) 슬라이딩
  const [sortBy, setSortBy] = useState<"recent" | "priority">(qbFilters.sortBy); // 기본=우선순위별 (백엔드 정렬 sort 파라미터)
  // 변경 시 모듈 캐시에 반영(다음 마운트에서 복원됨)
  useEffect(() => { qbFilters.mapFilter = mapFilter; qbFilters.dateFilter = dateFilter; qbFilters.afterTime = afterTime; qbFilters.liveNow = liveNow; qbFilters.sortBy = sortBy; }, [mapFilter, dateFilter, afterTime, liveNow, sortBy]);

  // "지금" 라이브 모드 — 켜져 있으면 기준 시각을 2초마다 (현재-30분)으로 갱신 → 최근 30분 창이 실시간 슬라이딩.
  useEffect(() => {
    if (!liveNow) return;
    setAfterTime(nowAfterPreset()); // 즉시 1회 반영
    const id = setInterval(() => setAfterTime(nowAfterPreset()), 2000);
    return () => clearInterval(id);
  }, [liveNow]);
  const [autoOn, setAutoOn] = useState(false); // AUTO DISPATCHER on/off (백엔드 상태)
  const [chargeOn, setChargeOn] = useState(false); // AUTO CHARGE on/off (백엔드 상태)
  const [items, setItems] = useState<FmsTask[]>(tasks); // 백엔드가 정렬해 준 목록(프론트는 표시만)
  const [adding, setAdding] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [addRect, setAddRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    let alive = true;
    // 백엔드 재시작 중이면 첫 fetch가 실패할 수 있어 몇 번 재시도(빈 드롭다운 방지)
    const jRetry = async <T,>(p: string, tries = 6): Promise<T | null> => {
      for (let i = 0; i < tries; i++) {
        try { const r = await fetch(`${BACKEND_URL}${p}`); if (r.ok) return (await r.json()) as T; } catch { /* 재시도 */ }
        if (!alive) return null;
        await new Promise((res) => setTimeout(res, 1500));
      }
      return null;
    };
    void jRetry<{ map_id: string }[]>("/api/fleet/maps").then((m) => { if (alive && Array.isArray(m)) setMaps(m.map((x) => x.map_id)); });
    void jRetry<FNode[]>("/api/fleet/topology/nodes").then((n) => { if (alive && Array.isArray(n)) setNodes(n); });
    void jRetry<{ robot_id: string }[]>("/api/fleet/robots").then((r) => { if (alive && Array.isArray(r)) setRobots(r.map((x) => x.robot_id)); });
    void jRetry<{ enabled: boolean }>("/api/fms/auto-dispatch").then((d) => { if (alive && d) setAutoOn(!!d.enabled); });
    void jRetry<{ enabled: boolean }>("/api/fms/auto-charge").then((d) => { if (alive && d) setChargeOn(!!d.enabled); });
    return () => { alive = false; };
  }, []);

  // AUTO DISPATCHER 토글 — 백엔드가 미배정 태스크를 우선순위순으로 최우선 가용 로봇에 자동 할당
  const toggleAuto = async () => {
    const next = !autoOn;
    setAutoOn(next); // 낙관적 반영
    try {
      const r = await fetch(`${BACKEND_URL}/api/fms/auto-dispatch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json() as { enabled: boolean };
      setAutoOn(!!d.enabled);
    } catch { setAutoOn(!next); }
  };

  // AUTO CHARGE 토글 — 충전 필요 로봇을 빈 충전소(가까운 순)로 자동 이동, 없으면 초기위치 충전 대기
  const toggleCharge = async () => {
    const next = !chargeOn;
    setChargeOn(next);
    try {
      const r = await fetch(`${BACKEND_URL}/api/fms/auto-charge`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json() as { enabled: boolean };
      setChargeOn(!!d.enabled);
    } catch { setChargeOn(!next); }
  };

  // 2초마다 백엔드에서 정렬된 목록을 자동 새로고침(+ sortBy/tasks 변경 시 즉시).
  useEffect(() => {
    let alive = true;
    // 기준 시각 이후 필터는 백엔드에서 처리(afterMs). 빈값이면 미적용.
    const afterMs = afterTime ? new Date(afterTime).getTime() : NaN;
    const fetchItems = () => {
      const q = `sort=${sortBy}&limit=200${Number.isFinite(afterMs) ? `&afterMs=${afterMs}` : ""}`;
      void fetch(`${BACKEND_URL}/api/fms/tasks?${q}`)
        .then((r) => r.json())
        .then((d: FmsTask[]) => { if (alive && Array.isArray(d)) setItems(d); })
        .catch(() => {});
    };
    fetchItems();
    const id = setInterval(fetchItems, 2000); // 2초 폴링
    return () => { alive = false; clearInterval(id); };
  }, [sortBy, tasks, afterTime]);

  const nodeToMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.node_id, n.map_id])), [nodes]);
  // 정렬은 백엔드가 끝낸 상태 — 프론트는 맵/날짜 필터만 적용(순서는 그대로 유지).
  const shown = useMemo(() => {
    // 기준 시각 이후 필터는 백엔드(afterMs)에서 처리됨. 여기선 맵/날짜만.
    let list = mapFilter ? items.filter((t) => nodeToMap[t.targetNode] === mapFilter) : items;
    if (dateFilter) list = list.filter((t) => ymdLocal(t.createdAt) === dateFilter);
    return list;
  }, [items, mapFilter, dateFilter, nodeToMap]);
  const dates = useMemo(() => Array.from(new Set(items.map((t) => ymdLocal(t.createdAt)))).sort().reverse(), [items]);

  // 반복 연속 정지 — 백엔드가 비종료 태스크 COMPLETED 처리로 로봇 큐 종료
  const stopBatch = async (batchId: string) => {
    try {
      await fetch(`${BACKEND_URL}/api/fms/tasks/batch/${batchId}/stop`, { method: "POST" });
    } catch { /* 무시 */ }
  };

  // 대기(DRAFT/PENDING) 태스크 DB 삭제 — 백엔드 remove 후 소켓 갱신으로 목록에서 사라짐
  const remove = async (taskId: string) => {
    try {
      await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}`, { method: "DELETE" });
    } catch { /* 무시 */ }
  };

  // DRAFT/PENDING 카드에서 로봇 지정 후 할당(백엔드가 로봇 설정 + PENDING 전환 + 실행)
  const dispatch = async (taskId: string, robotId: string) => {
    if (!robotId) return;
    try {
      await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}/dispatch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ robotId }),
      });
    } catch { /* 무시 */ }
  };

  // SUSPENDED(일시정지 보류) 카드 재개 — 백엔드가 들고 있던 큐를 그 지점부터 이어서 수행
  const resume = async (taskId: string) => {
    try {
      await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}/resume`, { method: "POST" });
    } catch { /* 무시 */ }
  };

  const tab = (id: "recent" | "priority", label: string) => (
    <button onClick={() => setSortBy(id)}
      className={`px-2 py-0.5 text-[10px] font-bold rounded transition-all ${sortBy === id ? "bg-orange-500/20 text-orange-600 border border-orange-500/30" : "text-white/45 hover:text-white/70 border border-transparent"}`}>
      {label}
    </button>
  );

  return (
    <div className={`flex-none backdrop-blur-2xl border-b border-white/[0.1] px-5 py-2.5 min-w-0 transition-colors ${autoOn ? "auto-dispatch-active" : "bg-[#FFCE99]/32"}`}>
      {/* ── 헤더줄 ── */}
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <span className="text-[11px] font-bold tracking-widest text-white/80 whitespace-nowrap">글로벌 태스크 큐</span>
        <span className="text-[11px] font-mono font-bold text-amber-600 bg-amber-500/15 px-1.5 py-0.5 rounded">{shown.length}</span>
        <Dropdown value={mapFilter} onChange={setMapFilter} title="맵 필터" className="flex-none w-[104px]"
          options={[{ value: "", label: "전체 맵" }, ...maps.map((m) => ({ value: m, label: m }))]} />
        <Dropdown value={dateFilter} onChange={setDateFilter} title="등록일 필터" className="flex-none w-[104px]"
          options={[{ value: "", label: "전체 날짜" }, ...dates.map((d) => ({ value: d, label: d.slice(5).replace("-", "/") }))]} />

        {/* 기준 시각 이후 필터 — 이 시각 이후 등록된 태스크만 표시 */}
        <div className="flex items-center gap-0.5 flex-none">
          <input type="datetime-local" value={afterTime} onChange={(e) => { setLiveNow(false); setAfterTime(e.target.value); }} title="기준 시각 이후 등록된 태스크만 표시 (직접 수정 시 라이브 해제)"
            className={`text-[10px] rounded px-1.5 py-1 border w-[158px] ${afterTime ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/40" : "bg-black/10 text-white/60 border-white/[0.14]"}`} />
          <button onClick={() => setLiveNow(true)} title="지금 — 최근 30분 작업을 2초마다 갱신(라이브)"
            className={`flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold rounded border transition-all whitespace-nowrap ${liveNow ? "bg-emerald-500/25 text-emerald-700 border-emerald-500/50 shadow-sm" : "text-white/45 border-white/[0.14] hover:text-white/70 hover:border-white/[0.25]"}`}>
            {liveNow && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            지금
          </button>
          {afterTime && <button onClick={() => { setLiveNow(false); setAfterTime(""); }} title="기준 시각 해제" className="px-1 text-[11px] leading-none text-white/40 hover:text-rose-500">✕</button>}
        </div>

        <div className="flex items-center gap-0.5 bg-black/10 rounded-lg p-0.5">
          {tab("priority", "우선순위별")}
          {tab("recent", "최근 등록순")}
        </div>

        {/* AUTO DISPATCHER — on/off. ON이면 미배정 태스크를 우선순위순으로 최우선 가용 로봇에 자동 할당 */}
        <button onClick={toggleAuto} title="자동 디스패처 — 미배정 태스크를 우선순위·최우선 로봇에 자동 할당"
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-extrabold rounded-lg border transition-all whitespace-nowrap ${autoOn ? "bg-emerald-500/25 text-emerald-700 border-emerald-500/50 shadow-sm" : "text-white/45 border-white/[0.14] hover:text-white/70 hover:border-white/[0.25]"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${autoOn ? "bg-emerald-500 animate-pulse" : "bg-white/30"}`} />
          AUTO DISPATCHER · {autoOn ? "ON" : "OFF"}
        </button>

        {/* AUTO CHARGE — 충전 필요 로봇을 빈 충전소(가까운 순)로 자동 이동, 만석이면 초기위치 대기 */}
        <button onClick={toggleCharge} title="자동 충전 — 저배터리 로봇을 가까운 빈 충전소로, 만석이면 초기위치 대기"
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-extrabold rounded-lg border transition-all whitespace-nowrap ${chargeOn ? "bg-amber-500/25 text-amber-700 border-amber-500/50 shadow-sm" : "text-white/45 border-white/[0.14] hover:text-white/70 hover:border-white/[0.25]"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${chargeOn ? "bg-amber-500 animate-pulse" : "bg-white/30"}`} />
          ⚡ AUTO CHARGE · {chargeOn ? "ON" : "OFF"}
        </button>

        <div className="flex-1" />

        <button ref={addBtnRef}
          onClick={() => { const open = !adding; if (open && addBtnRef.current) setAddRect(addBtnRef.current.getBoundingClientRect()); setAdding(open); }}
          className={`flex-none px-3.5 py-1.5 text-[12px] font-extrabold rounded-lg shadow-lg whitespace-nowrap transition-all border ${adding ? "bg-paper text-slate-700 border-slate-300 hover:bg-slate-100" : "bg-emerald-500 text-paper border-emerald-400 hover:bg-emerald-600"}`}>
          {adding ? "✕ 닫기" : "＋ 태스크 추가"}
        </button>
      </div>

      {/* 태스크 추가 — 버튼 위치에 떠 있는 플로팅 패널(포털) */}
      {adding && <AddTaskPanel nodes={nodes} maps={maps} anchorRect={addRect} onClose={() => setAdding(false)} />}

      {/* ── 카드줄: 태스크 카드 (추가는 위 플로팅 패널에서) ── */}
      <div className="flex items-stretch gap-2 overflow-x-auto pb-0.5 min-h-[112px]">
        {shown.length === 0 ? (
          <div className="flex items-center text-[11px] text-white/40 px-1">큐에 태스크가 없습니다 — “＋ 태스크 추가”로 등록하세요.</div>
        ) : (() => {
          // 같은 batchId는 한 카드로 묶고, 단건은 개별 카드로. shown 순서를 유지(연속은 첫 등장 위치에).
          const seen = new Set<string>();
          return shown.map((t) => {
            if (t.scenarioId) {
              if (seen.has(t.scenarioId)) return null;
              seen.add(t.scenarioId);
              const group = shown.filter((x) => x.scenarioId === t.scenarioId);
              return <ScenarioCard key={t.scenarioId} tasks={group} onDelete={remove} />;
            }
            if (t.batchId) {
              if (seen.has(t.batchId)) return null;
              seen.add(t.batchId);
              const group = shown.filter((x) => x.batchId === t.batchId);
              return <BatchCard key={t.batchId} tasks={group} onDelete={remove} onStop={stopBatch} />;
            }
            return <TaskMiniCard key={t._id} task={t} robots={robots} onDispatch={dispatch} onDelete={remove} onResume={resume} />;
          });
        })()}
      </div>
    </div>
  );
}
