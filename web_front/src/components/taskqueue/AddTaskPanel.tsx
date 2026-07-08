import { useState, useEffect, useRef, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { BACKEND_URL } from "../../config";
import { taskTypeKo } from "../../utils/statusLabel";
import { type RankedRobot, fetchRobotRanking } from "../../utils/robotRanking";
import { type FNode, TYPES, BATCH_TYPES, SCENARIO_TYPES, SUPPLY_ITEMS, TYPE_DOT, robotIcon } from "./shared";
import { Picker } from "./Picker";
import { isTestBot } from "../../robots";
import { useTestBots } from "../../context/testbots";

// 태스크 추가 — 버튼 위치에 떠 있는 플로팅 패널(포털). 유형/맵/목적지=검색 리스트, 수행로봇=카드.
export function AddTaskPanel({ nodes, maps, anchorRect, onClose }: { nodes: FNode[]; maps: string[]; anchorRect: DOMRect | null; onClose: () => void }) {
  const [mode, setMode] = useState<"single" | "batch" | "scenario">("single");
  const [type, setType] = useState<string>("MOVE");
  const [mapSel, setMapSel] = useState(""); // 현재 맵 (목적지 노드 필터)
  const [targetNode, setTargetNode] = useState("");
  const [robotId, setRobotId] = useState("");
  // 연속은 한 로봇(robotId)에 type/targetNode만 / 시나리오는 스텝마다 로봇(robotId)도 다름
  const [steps, setSteps] = useState<{ type: string; targetNode: string; robotId?: string }[]>([]);
  const [repeat, setRepeat] = useState(false);
  const [ranking, setRanking] = useState<RankedRobot[]>([]);
  const { showTestBots } = useTestBots();
  const [err, setErr] = useState("");
  const [customId, setCustomId] = useState("");  // 선택된 커스텀 태스크(빌더 정의) id — "" = 기본 유형
  const [customDefs, setCustomDefs] = useState<{ _id: string; name: string; targetNode?: string; preferredRobotId?: string | null; steps?: unknown[] }[]>([]);
  // 목적지 노드 — 패널을 열 때마다 최신 토폴로지를 새로 받아온다. 부모(GlobalTaskQueueBar)는 마운트 시 1회만
  // 노드를 받으므로, 런타임에 동적 생성된 임시 VICTIM 노드(/victim/confirmed)가 stale prop에 빠질 수 있다.
  // → 여기서 새로 받아 "이동(MOVE)" 등 목적지 목록에 임시노드가 바로 뜨게 한다.
  const [liveNodes, setLiveNodes] = useState<FNode[]>(nodes);
  useEffect(() => {
    let alive = true;
    void fetch(`${BACKEND_URL}/api/fleet/topology/nodes`).then((r) => r.json())
      .then((d: FNode[]) => { if (alive && Array.isArray(d)) setLiveNodes(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // 빌더에서 저장한 커스텀 태스크 — "유형"에 함께 노출(선택 시 runTaskDef로 로봇·목적지에 실행)
  useEffect(() => {
    void fetch(`${BACKEND_URL}/api/fms/task-defs`).then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setCustomDefs(d); }).catch(() => {});
  }, []);

  const isSupply = type === "SUPPLY";
  const isCharge = type === "CHARGE";
  const isRecall = type === "RECALL";
  const isPause = type === "PAUSE";
  const noDest = isCharge || isRecall || isPause; // 목적지 없는 로봇 전용 유형(충전·복귀·일시정지)
  const isCustom = !!customId;                    // 커스텀 태스크(빌더 정의) 선택됨 — 로봇 무관(tb3/TEST-BOT 공통)
  const targetNodes = liveNodes.filter((n) => !mapSel || n.map_id === mapSel);

  // 추천 로봇 가로 드래그 스크롤 + 바운스백(가장자리 고무줄)
  const dragRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ down: false, startX: 0, scroll: 0, moved: false });
  const onDragDown = (e: ReactMouseEvent) => {
    if (!dragRef.current) return;
    drag.current = { down: true, startX: e.clientX, scroll: dragRef.current.scrollLeft, moved: false };
    if (innerRef.current) innerRef.current.style.transition = "none";
  };
  const onDragMove = (e: ReactMouseEvent) => {
    if (!drag.current.down || !dragRef.current) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    const el = dragRef.current;
    const max = el.scrollWidth - el.clientWidth;
    const desired = drag.current.scroll - dx;
    const clamped = Math.max(0, Math.min(max, desired));
    el.scrollLeft = clamped;
    const over = desired - clamped; // 양끝 넘은 양 → 고무줄
    if (innerRef.current) innerRef.current.style.transform = `translateX(${-over * 0.3}px)`;
  };
  const onDragEnd = () => {
    if (!drag.current.down) return;
    drag.current.down = false;
    if (innerRef.current) { innerRef.current.style.transition = "transform 0.35s cubic-bezier(.22,1,.36,1)"; innerRef.current.style.transform = "translateX(0)"; }
  };

  // 단건: (충전·복귀이거나 목적지 선택됨)일 때 / 연속: 항상 — 매번 호출 시점 상태로 추천
  const robotReady = mode === "batch" || noDest || isCustom || (!isSupply && !!targetNode);
  useEffect(() => {
    if (!robotReady) { setRanking([]); return; }
    let alive = true;
    const tgt = mode === "batch" || noDest ? "" : targetNode;
    void fetchRobotRanking(tgt, type).then((d) => { if (alive) setRanking(d); });
    return () => { alive = false; };
  }, [robotReady, mode, type, targetNode, noDest]);

  const robotCards = ranking.filter((r) => (showTestBots || !isTestBot(r.robotId)) && (mode === "batch" ? !r.robotId.startsWith("omx") : isSupply ? r.robotId.startsWith("omx") : !r.robotId.startsWith("omx")));
  const onSelectType = (v: string) => { setType(v); setCustomId(""); setTargetNode(""); setRobotId(""); setErr(""); };
  const onSelectCustom = (id: string) => { setCustomId(id); setType(""); setTargetNode(""); setRobotId(""); setErr(""); };
  const mapItems = [{ v: "", l: "전체 맵" }, ...maps.map((m) => ({ v: m, l: m }))];
  // 임시 조난자 노드(VICTIM)는 🆘로 식별 가능하게 표시 — "이동" 목적지로 바로 고를 수 있다.
  const nodeItems = targetNodes.map((n) => ({ v: n.node_id, l: n.type === "VICTIM" ? `🆘 ${n.node_id}` : n.node_id, sub: n.map_id }));

  const createSingle = async () => {
    if (isCustom) { // 커스텀 태스크 — runTaskDef로 선택 로봇에 실행(스텝대로). 로봇 비면 추천 자동.
      try {
        const body: Record<string, unknown> = {};
        if (robotId) body.robotId = robotId;
        const r = await fetch(`${BACKEND_URL}/api/fms/task-defs/${customId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        onClose();
      } catch (e) { setErr(`실행 실패: ${String(e)}`); }
      return;
    }
    if (isSupply && !targetNode) { setErr("품목을 선택하세요"); return; }
    if (noDest && !robotId) { setErr(isRecall ? "복귀할 로봇을 선택하세요" : isPause ? "일시정지할 로봇을 선택하세요" : "충전할 로봇을 선택하세요"); return; }
    if (!isSupply && !noDest && !targetNode) { setErr("목적지를 선택하세요"); return; }
    try {
      const body: Record<string, unknown> = { type, priority: isRecall || isPause ? 1 : 5 };
      if (!noDest) body.targetNode = targetNode;
      const robot = isSupply ? "omx" : robotId;
      if (robot) body.preferredRobotId = robot;
      body.draft = !robot;
      const r = await fetch(`${BACKEND_URL}/api/fms/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClose();
    } catch (e) { setErr(`추가 실패: ${String(e)}`); }
  };
  const addStep = () => {
    if (type !== "RECALL" && !targetNode) { setErr("목적지를 선택하세요"); return; }
    setSteps((s) => [...s, { type, targetNode: type === "RECALL" ? "" : targetNode }]); setTargetNode(""); setErr("");
  };
  const runBatch = async () => {
    if (!robotId) { setErr("로봇을 선택하세요"); return; }
    if (steps.length === 0) { setErr("단계를 1개 이상 추가하세요"); return; }
    try {
      const body = { preferredRobotId: robotId, repeat, tasks: steps.map((s) => ({ type: s.type, targetNode: s.targetNode, priority: s.type === "RECALL" ? 1 : 5 })) };
      const r = await fetch(`${BACKEND_URL}/api/fms/tasks/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClose();
    } catch (e) { setErr(`연속 실패: ${String(e)}`); }
  };
  // 시나리오: 단건 스텝(유형+목적지+로봇)을 누적. 스텝마다 로봇이 다를 수 있다.
  const addScenarioStep = () => {
    if (isSupply && !targetNode) { setErr("품목을 선택하세요"); return; }
    if (!isSupply && !noDest && !targetNode) { setErr("목적지를 선택하세요"); return; }
    const robot = isSupply ? "omx" : robotId;
    if (!robot) { setErr("수행 로봇을 선택하세요"); return; }
    setSteps((s) => [...s, { type, targetNode: noDest ? "" : targetNode, robotId: robot }]);
    setTargetNode(""); setRobotId(""); setErr("");
  };
  const runScenario = async () => {
    if (steps.length === 0) { setErr("스텝을 1개 이상 추가하세요"); return; }
    try {
      const body = { steps: steps.map((s) => ({ type: s.type, targetNode: s.targetNode, preferredRobotId: s.robotId, priority: s.type === "RECALL" ? 1 : 5 })) };
      const r = await fetch(`${BACKEND_URL}/api/fms/tasks/scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClose();
    } catch (e) { setErr(`시나리오 실패: ${String(e)}`); }
  };

  const Label = (t: string, extra?: ReactNode) => (
    <div className="text-[9px] font-bold tracking-widest text-white/40 uppercase mb-1">{t} {extra}</div>
  );
  // 유형 — 버튼 50%씩(2열), 타입별 색
  const typeButtons = (types: readonly string[]) => (
    <div>
      {Label("유형")}
      <div className="grid grid-cols-2 gap-1">
        {types.map((tp) => (
          <button key={tp} onClick={() => onSelectType(tp)}
            className={`py-2 text-[12px] font-bold rounded-lg border transition-all ${type === tp ? `${TYPE_DOT[tp] ?? "bg-emerald-500"} text-paper border-transparent shadow` : "bg-white/[0.06] text-white/75 border-white/[0.1] hover:bg-white/[0.1]"}`}>
            {taskTypeKo(tp)}
          </button>
        ))}
      </div>
    </div>
  );
  // 수행 로봇 — 2줄 가로 흐름 + 드래그 스크롤. 가운데 큰 아이콘.
  const robotCardList = (
    // 빈 공간(카드 아님) 클릭 → 현재 선택 로봇 해제(초기화)
    <div onClick={(e) => { if (!drag.current.moved && !(e.target as HTMLElement).closest("button")) setRobotId(""); }}>
      {Label("수행 로봇", <span className="text-amber-600/80">· 추천순 · 빈 곳 클릭=해제</span>)}
      {robotCards.length === 0 ? <div className="px-2 py-2 text-[10px] text-white/40">추천 로봇 없음</div> : (
        <div ref={dragRef} onMouseDown={onDragDown} onMouseMove={onDragMove} onMouseUp={onDragEnd} onMouseLeave={onDragEnd}
          className="overflow-x-auto overflow-y-hidden cursor-grab active:cursor-grabbing select-none pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div ref={innerRef} className="grid grid-rows-2 grid-flow-col auto-cols-[200px] gap-1.5 w-max">
            {robotCards.map((r) => {
              const sel = robotId === r.robotId;
              const low = r.batteryPct != null && r.batteryPct < 40;
              return (
                <button key={r.robotId} disabled={!r.online || !!r.error}
                  onClick={() => { if (drag.current.moved) return; setRobotId(r.robotId); }}
                  className={`flex flex-col items-center text-center rounded-xl border p-2 transition-all ${sel ? "bg-sky-500/20 border-sky-400/60 ring-1 ring-sky-400/50" : r.error ? "bg-rose-500/[0.08] border-rose-400/30 opacity-50 cursor-not-allowed" : r.online ? "bg-white/[0.06] border-white/[0.1] hover:border-white/[0.2]" : "bg-white/[0.03] border-white/[0.1] opacity-50 cursor-not-allowed"}`}>
                  <div className="flex items-center justify-between w-full">
                    <span className={`text-[10px] font-extrabold ${r.rank === 1 && r.online && !r.error ? "text-amber-500" : "text-white/30"}`}>{r.rank === 1 && r.online && !r.error ? "★" : `#${r.rank}`}</span>
                    <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${r.error ? "bg-rose-500/40 text-rose-50" : r.online ? (r.busy ? "bg-sky-500/30 text-white" : "bg-white/15 text-white/70") : "bg-white/[0.08] text-white/40"}`}>
                      {r.error ? "오류" : r.online ? (r.busy ? "작업중" : "대기") : "오프라인"}
                    </span>
                  </div>
                  <span className="text-[30px] leading-none my-1">{robotIcon(r.robotId)}</span>
                  <span className="font-mono font-extrabold text-[12px] text-white truncate w-full">{r.robotId}</span>
                  <div className="flex flex-col items-center gap-0.5 mt-1 text-[9px] font-mono text-white/55 w-full">
                    <span className={low ? "text-rose-500 font-bold" : ""}>🔋{r.batteryPct != null ? `${r.batteryPct}%` : "—"}</span>
                    <span className="truncate max-w-full">📍{r.node ?? "—"}</span>
                    {r.distance != null && <span>↦{r.distance.toFixed(1)}m</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  const pos = anchorRect
    ? { top: anchorRect.bottom + 8, right: Math.max(8, window.innerWidth - anchorRect.right) }
    : { top: 60, right: 20 };

  return createPortal(
    <>
      {/* 바깥 클릭 닫기용 투명 캐처 — 어두운 오버레이 없음 */}
      <div className="fixed inset-0 z-[1900]" onClick={onClose} />
      <div style={{ position: "fixed", ...pos }}
        className="z-[2000] w-[480px] max-w-[94vw] max-h-[84vh] overflow-y-auto rounded-2xl glass-panel shadow-2xl text-white/85 p-3.5 flex flex-col gap-2.5">
        {/* 헤더 */}
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-extrabold text-white/85">＋ 새 태스크</span>
          <button onClick={onClose} className="ml-auto flex-none w-6 h-6 flex items-center justify-center rounded-lg text-white/40 hover:text-white/85 hover:bg-white/[0.1] text-sm">✕</button>
        </div>

        {/* 모드 토글 — 단건 / 연속 / 시나리오 (선택=흰색) */}
        <div className="grid grid-cols-3 gap-1 bg-white/[0.08] rounded-xl p-1">
          {([["single", "단건"], ["batch", "연속"], ["scenario", "시나리오"]] as const).map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); setTargetNode(""); setRobotId(""); setSteps([]); setErr(""); if (m === "batch" && !(["MOVE", "PROCESS", "RECALL"] as string[]).includes(type)) setType("MOVE"); if (m === "scenario" && !(SCENARIO_TYPES as readonly string[]).includes(type)) setType("MOVE"); }}
              className={`py-1.5 text-[12px] font-extrabold rounded-lg transition-all ${mode === m ? "bg-white/25 text-white shadow" : "text-white/55 hover:text-white/85"}`}>
              {label}
            </button>
          ))}
        </div>

        {mode === "single" ? (
          <>
            {typeButtons(TYPES)}
            {/* 빌더에서 만든 커스텀 태스크 — 유형으로 함께 선택(고른 로봇=tb3/TEST-BOT에서 실행) */}
            {customDefs.length > 0 && (
              <div>
                {Label("커스텀 태스크", <span className="text-violet-600/80">· 빌더 정의</span>)}
                <div className="grid grid-cols-2 gap-1">
                  {customDefs.map((d) => (
                    <button key={d._id} onClick={() => onSelectCustom(d._id)}
                      className={`py-2 text-[12px] font-bold rounded-lg border transition-all truncate ${customId === d._id ? "bg-violet-500 text-paper border-transparent shadow" : "bg-white/[0.06] text-white/75 border-white/[0.1] hover:bg-white/[0.1]"}`}>
                      🧱 {d.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 목적지(검색 리스트) / 품목 / 충전·복귀는 목적지 없음(로봇 전용) */}
            {isCustom ? (
              <div className="text-[10px] text-white/55 px-1">빌더에서 정의한 <span className="text-violet-600 font-bold">ROS 액션 스텝</span>(이동·서비스·…)대로 실행됩니다. 수행 로봇만 고르세요.</div>
            ) : isSupply ? (
              <div>{Label("품목")}
                <div className="grid grid-cols-2 gap-1">
                  {SUPPLY_ITEMS.map((it) => (
                    <button key={it} onClick={() => setTargetNode(it)}
                      className={`py-2 text-sm font-bold rounded-lg border ${targetNode === it ? "bg-sky-500 text-paper border-sky-500" : "bg-white/[0.06] text-white/75 border-white/[0.1] hover:bg-white/[0.1]"}`}>
                      {it === "물" ? "💧 물" : "💊 약"}
                    </button>
                  ))}
                </div>
              </div>
            ) : !noDest ? (
              <>
                <Picker label="현재 맵" value={mapSel} items={mapItems} onSelect={(v) => { setMapSel(v); setTargetNode(""); }} />
                <Picker label="목적지" value={targetNode} items={nodeItems} onSelect={setTargetNode} />
              </>
            ) : isRecall ? (
              <div className="text-[10px] text-white/55 px-1">목적지 = 선택 로봇의 <span className="text-amber-600 font-bold">현재 맵 초기위치</span> (자동). 보유 태스크는 글로벌 큐로 반납됩니다.</div>
            ) : isPause ? (
              <div className="text-[10px] text-white/55 px-1">선택 로봇을 <span className="text-pink-600 font-bold">현재 위치에서 즉시 정지</span>합니다. 진행 중이던 태스크는 보류되며, 카드의 <span className="font-bold">▶ 재개</span>로 이어서 수행합니다.</div>
            ) : null}
            {/* 수행 로봇 카드 — 앞 단계 충족 후. 공급은 omx 고정이라 생략 */}
            {!isSupply && robotReady && robotCardList}
            {err && <span className="text-[10px] text-rose-600 font-bold">{err}</span>}
            <button onClick={createSingle}
              className="w-full py-2 text-[12px] font-extrabold rounded-lg bg-emerald-500 text-paper hover:bg-emerald-600 transition-colors">
              {isCustom ? (robotId ? `${robotId}에서 실행` : "실행 (추천 로봇 자동)") : isSupply ? "등록 (공급)" : isRecall ? "복귀 보내기" : isPause ? "일시정지 보내기" : isCharge ? "충전 보내기" : robotId ? `${robotId} 할당` : "등록 (로봇 미지정)"}
            </button>
          </>
        ) : mode === "batch" ? (
          <>
            {/* 연속: 로봇 카드 먼저 → 유형 → 맵 → 목적지 → 단계 추가 */}
            {robotCardList}
            {typeButtons(BATCH_TYPES)}
            {/* 복귀 단계는 목적지 없음(현재 맵 초기위치). 그 외는 맵/목적지 선택. */}
            {isRecall ? (
              <div className="text-[10px] text-white/55 px-1">복귀 단계: 목적지 = 현재 맵 <span className="text-amber-600 font-bold">초기위치</span> (자동)</div>
            ) : (
              <>
                <Picker label="현재 맵" value={mapSel} items={mapItems} onSelect={(v) => { setMapSel(v); setTargetNode(""); }} />
                <Picker label="목적지" value={targetNode} items={nodeItems} onSelect={setTargetNode} />
              </>
            )}
            <button onClick={addStep} disabled={!isRecall && !targetNode}
              className="w-full py-1.5 text-[11px] font-extrabold rounded-lg bg-sky-500 text-paper hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
              ＋ 단계 추가
            </button>
            <div>
              {Label("단계", <span className="normal-case text-white/40">실행 순서</span>)}
              <div className="flex flex-col gap-1 max-h-[110px] overflow-y-auto">
                {steps.length === 0 ? <div className="text-[10px] text-white/40 px-1 py-1">＋로 단계를 추가하세요</div>
                  : steps.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.08] border border-white/[0.1]">
                      <span className="text-[10px] font-extrabold text-amber-600 w-4 text-center flex-none">{i + 1}</span>
                      <span className="text-[10px] font-bold text-white/55 flex-none">{taskTypeKo(s.type)}</span>
                      <span className="font-mono text-[11px] text-white/85 truncate flex-1">→ {s.type === "RECALL" ? "초기위치" : s.targetNode}</span>
                      <button onClick={() => setSteps((x) => x.filter((_, idx) => idx !== i))} className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/40 hover:text-rose-600 hover:bg-rose-100 text-[11px] leading-none">✕</button>
                    </div>
                  ))}
              </div>
            </div>
            {/* 반복 주행 — 토글 스위치 */}
            <button onClick={() => setRepeat((v) => !v)}
              className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.1] hover:border-white/[0.2]">
              <span className="text-[11px] font-bold text-amber-700">🔁 반복 주행 <span className="text-white/40 font-normal">정지 전까지</span></span>
              <span className={`relative w-9 h-5 rounded-full flex-none transition-colors ${repeat ? "bg-amber-400" : "bg-white/15"}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper shadow transition-all ${repeat ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>
            {err && <span className="text-[10px] text-rose-600 font-bold">{err}</span>}
            <button onClick={runBatch} disabled={!robotId || steps.length === 0}
              className="w-full py-2 text-[12px] font-extrabold rounded-lg bg-emerald-500 text-paper hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {repeat ? "반복 실행" : "연속 실행"} ({steps.length})
            </button>
          </>
        ) : (
          <>
            {/* 시나리오: 스텝마다 (유형→목적지/품목→로봇) 지정 후 추가. 로봇이 달라도 됨 — 순서대로 실행 */}
            {typeButtons(SCENARIO_TYPES)}
            {isSupply ? (
              <div>{Label("품목")}
                <div className="grid grid-cols-2 gap-1">
                  {SUPPLY_ITEMS.map((it) => (
                    <button key={it} onClick={() => setTargetNode(it)}
                      className={`py-2 text-sm font-bold rounded-lg border ${targetNode === it ? "bg-sky-500 text-paper border-sky-500" : "bg-white/[0.06] text-white/75 border-white/[0.1] hover:bg-white/[0.1]"}`}>
                      {it === "물" ? "💧 물" : "💊 약"}
                    </button>
                  ))}
                </div>
              </div>
            ) : !noDest ? (
              <>
                <Picker label="현재 맵" value={mapSel} items={mapItems} onSelect={(v) => { setMapSel(v); setTargetNode(""); }} />
                <Picker label="목적지" value={targetNode} items={nodeItems} onSelect={setTargetNode} />
              </>
            ) : null}
            {/* 수행 로봇 — 스텝별. 공급은 omx 고정이라 생략 */}
            {!isSupply && robotReady && robotCardList}
            <button onClick={addScenarioStep}
              className="w-full py-1.5 text-[11px] font-extrabold rounded-lg bg-violet-500 text-paper hover:bg-violet-600">
              ＋ 스텝 추가
            </button>
            <div>
              {Label("스텝", <span className="normal-case text-white/40">실행 순서 · 로봇</span>)}
              <div className="flex flex-col gap-1 max-h-[140px] overflow-y-auto">
                {steps.length === 0 ? <div className="text-[10px] text-white/40 px-1 py-1">＋로 스텝을 추가하세요 (로봇 달라도 됨)</div>
                  : steps.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.08] border border-white/[0.1]">
                      <span className="text-[10px] font-extrabold text-violet-500 w-4 text-center flex-none">{i + 1}</span>
                      <span className="text-[10px] font-bold text-white/55 flex-none">{taskTypeKo(s.type)}</span>
                      <span className="font-mono text-[11px] text-white/85 truncate flex-1">→ {s.type === "CHARGE" ? "충전" : s.type === "RECALL" ? "초기위치" : s.targetNode || "—"}</span>
                      <span className="flex items-center gap-0.5 text-[10px] font-mono text-sky-300 flex-none max-w-[78px] truncate" title={s.robotId}>{robotIcon(s.robotId ?? "")}{s.robotId}</span>
                      <button onClick={() => setSteps((x) => x.filter((_, idx) => idx !== i))} className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/40 hover:text-rose-600 hover:bg-rose-100 text-[11px] leading-none">✕</button>
                    </div>
                  ))}
              </div>
            </div>
            {err && <span className="text-[10px] text-rose-600 font-bold">{err}</span>}
            <button onClick={runScenario} disabled={steps.length === 0}
              className="w-full py-2 text-[12px] font-extrabold rounded-lg bg-emerald-500 text-paper hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              시나리오 실행 ({steps.length})
            </button>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
