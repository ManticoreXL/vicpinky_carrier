import React, { useState } from "react";

/* ── 색상 클래스 ─────────────────────────────────────────── */
const CLS = {
  start:    "bg-emerald-700/70 border-emerald-400/80 text-emerald-100",
  process:  "bg-blue-700/70   border-blue-400/80   text-blue-100",
  decision: "bg-amber-600/70  border-amber-400/80  text-amber-100",
  warning:  "bg-red-700/60    border-red-400/80    text-red-100",
  wait:     "bg-[#521C0D]/15  border-slate-400/60  text-[#521C0D] border-dashed",
};

/* ── 기본 노드 컴포넌트 ──────────────────────────────────── */
function Node({
  label, cls, step, impl, wide, planned,
}: { label: string; cls: string; step?: number; impl?: string; wide?: boolean; planned?: boolean }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className="relative flex flex-col items-center">
      <div
        className={`border rounded-xl px-4 py-2 text-sm font-medium text-center cursor-default
                    transition-all duration-200 ${cls}
                    ${wide ? "min-w-[220px]" : "min-w-[170px]"}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {step && <span className="text-[10px] font-bold text-white/[0.82] mr-1">#{step}</span>}
        {label}
        {planned && <span className="ml-1.5 text-[9px] bg-amber-500/25 text-amber-100 px-1 py-0.5 rounded align-middle">예정</span>}
      </div>
      {hover && impl && (
        <div className="absolute top-full mt-2 z-50 bg-[#FFFDF1] border border-[#562F20]/20
                        rounded-lg px-3 py-2 text-[11px] text-[#521C0D]/80 whitespace-nowrap
                        shadow-2xl pointer-events-none">
          <span className="text-[#562F20]/50 mr-1">impl:</span>{impl}
        </div>
      )}
    </div>
  );
}

function Diamond({ label, cls }: { label: string; cls: string }) {
  return (
    <div className={`border-2 rounded-lg px-5 py-2 text-sm font-semibold text-center ${cls} min-w-[190px]`}>
      {label}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center my-0.5">
      {label && <span className="text-[10px] text-white/[0.82] mb-0.5">{label}</span>}
      <div className="w-px h-5 bg-white/40" />
      <div className="w-0 h-0 border-l-4 border-r-4 border-t-6 border-l-transparent border-r-transparent border-t-white/60" />
    </div>
  );
}

function DashLoop({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 my-1 px-3 py-1 border border-dashed border-white/30
                    rounded-lg text-[10px] text-white/[0.75]">
      <span className="text-white/[0.6]">↩</span> {label}
    </div>
  );
}

/* ── 차트 1: 태스크 워크플로우 (생성 → 배정 → 실행 → 완료) ──────
 *  근거: web_back/FMS_TASK_MANAGER.md §4, §7 / task.md §2,§4 */
function WorkflowChart() {
  return (
    <div className="flex flex-col items-center flex-1">
      <Node label="태스크 생성 → 글로벌 큐(PENDING / DRAFT)" cls={CLS.start} wide
            impl="GlobalTaskQueueService: enqueue(PENDING)·register(DRAFT)·enqueueBatch·enqueueScenario · runTaskDef/runSequence — 글로벌 큐 = Mongo fms_tasks 문서 집합" />
      <Arrow label="글로벌 큐 = Mongo의 PENDING / DRAFT 문서" />
      <Node label="배정 dispatchTask(taskId)" cls={CLS.process} step={1} wide
            impl="수동(사용자) 또는 AutoDispatcher 2초 tick · preferredRobotId 온라인·비busy·비ERROR 검증 → 타입별 핸들러" />
      <Arrow label="타입 분기 (→ '타입별 처리' 차트)" />
      <Node label="핸들러 → ROS 플랜 생성 (rosPlan)" cls={CLS.process} step={2} wide
            impl="handleNav(resolvePath→findPath→buildRosPlan) / handleSupply / handlePause / handleCustomPlan" />
      <Arrow />
      <Node label="실행 startPlan — rosPlan[0] 발행 (rosCursor=0)" cls={CLS.process} step={3} wide
            impl="TaskExecutionService.startPlan → goal_pose 발행 · DB RUNNING · 중간노드 도착 시 advance(rosCursor++) → 다음 스텝" />
      <Arrow label="최종 노드 도착 감지" />
      <Diamond label="도착 감지 방식?" cls={CLS.decision} />
      <div className="flex w-full justify-center gap-8 mt-1">
        <div className="flex flex-col items-center">
          <Arrow label="실 TB3 (tb3*)" />
          <Node label="navigate_to_pose 액션 result" cls={CLS.process} wide
                impl="onNavResult: status===4 도착(SUCCEEDED) / ===6 실패(ABORTED) — ROS2 GoalStatus, amcl 임계 미사용" />
        </div>
        <div className="flex flex-col items-center">
          <Arrow label="TEST / 기타 봇" />
          <Node label="amcl_pose 거리 임계 (checkWaypointArrival)" cls={CLS.process} wide
                impl="computeArrivalThreshold: TEST 0.05m / 최종노드 0.5m / 중간노드 ~1.5m" />
        </div>
      </div>
      <Arrow label="도착" />
      <Node label="completeTask → COMPLETED" cls={CLS.process} step={4} wide
            impl="active 해제 · status COMPLETED · Alert.completed" />
      <Arrow />
      <Diamond label="도착 노드가 CHARGER?" cls={CLS.decision} />
      <div className="flex w-full justify-center gap-8 mt-1">
        <div className="flex flex-col items-center">
          <Arrow label="예" />
          <Node label="로봇 CHARGING (+노드 잠금 유지)" cls={CLS.process}
                impl="충전소 도착 — 잠금/점유 유지" />
        </div>
        <div className="flex flex-col items-center">
          <Arrow label="아니오" />
          <Node label="로봇 IDLE (+잠금·점유 해제)" cls={CLS.start}
                impl="대기 상태로 — 다음 배정 가능" />
        </div>
      </div>
      <Arrow />
      <Node label="다음: dispatchNext + advanceScenario + repeat" cls={CLS.start} wide
            impl="dispatchNext(로봇별 FIFO seq↑,createdAt↑) · advanceScenario(시나리오 핸드오프) · repeat 연속이면 restartRepeatCycle" />
      <DashLoop label="로봇별 큐의 다음 태스크로 순환" />
    </div>
  );
}

/* ── 차트 2: 태스크 타입별 처리 (dispatch 분기) ────────────────
 *  근거: web_back/FMS_TASK_MANAGER.md §6 / task.md §2 */
function DispatchChart() {
  return (
    <div className="flex flex-col items-center flex-1">
      <Node label="dispatch — 태스크 타입 분기" cls={CLS.start} wide
            impl="DispatchService.dispatchTask — preferredRobotId 검증 후 핸들러 선택" />
      <Arrow />
      <Diamond label="커스텀 rosPlan 보유? (preempt 타입 제외)" cls={CLS.decision} />
      <div className="flex w-full justify-center gap-8 mt-1">
        {/* 커스텀 rosPlan */}
        <div className="flex flex-col items-center">
          <Arrow label="예" />
          <Node label="handleCustomPlan" cls={CLS.process} wide
                impl="경로계산 없이 저장된 rosPlan 스텝 그대로 실행 — move / service / action / topic / wait / signal" />
        </div>
        {/* 타입별 분기 */}
        <div className="flex flex-col items-center">
          <Arrow label="아니오" />
          <Diamond label="TaskType?" cls={CLS.decision} />
          <div className="flex gap-6 mt-1">
            {/* 주행 계열 */}
            <div className="flex flex-col items-center">
              <Arrow label="MOVE·PROCESS·CHARGE·RECALL" />
              <Node label="handleNav — 경로탐색→buildRosPlan→startPlan" cls={CLS.process} step={1} wide
                    impl="resolvePath → pathfinding.findPath → buildRosPlan(goal_pose / nav action) · targetNode 잠금(nodeLock)" />
              <Arrow />
              <Node label="상태: WORKING / TO_CHARGE / RETURNING" cls={CLS.process} wide
                    impl="movingStatusFor — MOVE·PROCESS·SUPPLY→WORKING, CHARGE→TO_CHARGE, RECALL→RETURNING(handleRecall→initPosition)" />
              <Arrow />
              <Node label="⚠ CHARGE: 충전소 노드 미해석 → FAILED 가능" cls={CLS.warning} wide planned
                    impl="수동 CHARGE는 목적지 해석 단계 없어 targetNode='' → FAILED · auto-charge는 nearestCharger로 정상 (FMS_TASK_MANAGER §11)" />
            </div>
            {/* SUPPLY */}
            <div className="flex flex-col items-center">
              <Arrow label="SUPPLY (omx 전용)" />
              <Node label="handleSupply" cls={CLS.process} step={2} wide
                    impl="/omx/vision/start_inference std_msgs/Bool{data:true} 발행 · 상태 LOADING" />
              <Arrow label="is_loaded / 30s" />
              <Diamond label="is_loaded = true?" cls={CLS.decision} />
              <div className="flex gap-4 mt-1">
                <div className="flex flex-col items-center">
                  <Arrow label="예" />
                  <Node label="onSupplyLoaded → COMPLETED + IDLE" cls={CLS.start} wide />
                </div>
                <div className="flex flex-col items-center">
                  <Arrow label="30s 초과" />
                  <Node label="onSupplyTimeout → FAILED" cls={CLS.warning}
                        impl="SUPPLY_TIMEOUT_MS = 30000" />
                </div>
              </div>
            </div>
            {/* PAUSE */}
            <div className="flex flex-col items-center">
              <Arrow label="PAUSE (preempt)" />
              <Node label="handlePause — cancelNav + hardStop(cmd_vel=0)" cls={CLS.warning} step={3} wide
                    impl="진행 중인 주행 즉시 정지" />
              <Arrow />
              <Node label="진행분 SUSPENDED · PAUSE 즉시 COMPLETED · 로봇 PAUSED" cls={CLS.wait} wide />
              <DashLoop label="재개 = resumeTask → resumePlan (goal_pose 재전송)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 차트 3: 자동 배정 · 적합 로봇 선정 (AutoDispatcher) ────────
 *  근거: web_back/FMS_TASK_MANAGER.md §5, §8, §9 / task.md §5 */
function AutoDispatchChart() {
  return (
    <div className="flex flex-col items-center flex-1">
      <Node label="AutoDispatcher 2초 tick (자동 배정 ON)" cls={CLS.start} wide
            impl="상태 tick → autoDispatcher.runIfEnabled · 배정 경로 3종: 수동 dispatchTask / 자동 / 순차 dispatchNext·advanceScenario" />
      <Arrow />
      <Node label="태스크 선택 — findAutoDispatchable (task-priority 순)" cls={CLS.process} step={1} wide
            impl="task-priority.ts 2키 내림차순: STATUS_RANK(DRAFT5>PENDING4>RUNNING3>…) → TYPE_PRIORITY(RECALL/PAUSE20>PROCESS10>MOVE/SUPPLY5>CHARGE1)" />
      <Arrow />
      <Node label="가용 로봇 후보 필터" cls={CLS.process} step={2} wide
            impl="온라인 · 비busy · 비ERROR · SUPPLY=omx 전용 / 그 외 omx 제외" />
      <Arrow />
      <Diamond label="후보 로봇 있음?" cls={CLS.decision} />
      <div className="flex w-full justify-center gap-8 mt-1">
        <div className="flex flex-col items-center">
          <Arrow label="없음 (0대)" />
          <Node label="PENDING 유지 — 다음 tick 재시도" cls={CLS.wait} />
          <DashLoop label="2초 tick 재확인" />
        </div>
        <div className="flex flex-col items-center">
          <Arrow label="있음" />
          <Node label="robot-priority 사전식 비교 (가중치 없음)" cls={CLS.process} step={3} wide
                impl="robot-priority.ts · BATTERY_OK_PCT=40" />
          <Arrow label="1순위" />
          <Node label="온라인 우선" cls={CLS.process} />
          <Arrow label="2순위" />
          <Node label="비busy (!busy) 우선" cls={CLS.process} />
          <Arrow label="3순위 — 타입별" />
          <Diamond label="태스크가 CHARGE?" cls={CLS.decision} />
          <div className="flex gap-6 mt-1">
            <div className="flex flex-col items-center">
              <Arrow label="예 (CHARGE)" />
              <Node label="배터리 오름차순 (낮을수록 먼저 = 가장 급함)" cls={CLS.process} wide />
            </div>
            <div className="flex flex-col items-center">
              <Arrow label="아니오 (MOVE/PROCESS/SUPPLY)" />
              <Node label="배터리 ≥40 우선 → 거리 오름차순" cls={CLS.process} wide />
            </div>
          </div>
          <Arrow label="최상위 로봇 선택" />
          <Node label="dispatchTask(taskId, robotId)" cls={CLS.start} wide
                impl="선택된 로봇에 배차 → 타입별 핸들러 ('타입별 처리' 차트)" />
        </div>
      </div>
    </div>
  );
}

/* ── 차트 4: 상태 · 충전 모니터링 (2초 tick) ──────────────────
 *  근거: web_back/FMS_TASK_MANAGER.md §10, §11 / task.md §3,§5 */
function MonitorChart() {
  return (
    <div className="flex flex-col items-center flex-1">
      <Node label="RobotMonitorService — 2초 상태 tick + 텔레메트리 라우팅" cls={CLS.start} wide
            impl="STATUS_REFRESH_MS=2000 · syncOnlineStatus + reconcileChargingStatus + checkLowBattery · battery_state / amcl_pose / imu 라우팅" />
      <Arrow label="매 tick / 텔레메트리 수신 시 조건 평가" />
      <div className="flex w-full justify-center gap-6 mt-1">
        {/* 저배터리 → 충전 */}
        <div className="flex flex-col items-center">
          <Diamond label="배터리 < 20% (온라인·비충전)?" cls={CLS.decision} />
          <Arrow label="예" />
          <Node label="Alert.lowBattery (에피소드당 1회 래치)" cls={CLS.warning} wide
                impl="checkLowBattery · LOW_BATTERY_PCT=20 · needsCharge() 래치 — +5% 회복/충전 시 해제" />
          <Arrow label="프론트: 확인 / 자동충전" />
          <Node label="auto-charge ON → nearestCharger로 CHARGE 배차" cls={CLS.process} wide
                impl="AutoChargerService — hop 최단 빈 충전소 / 만석이면 initPosition WAITING_CHARGE / 진행 작업은 선점 안 함" />
        </div>
        {/* 충전 완료 */}
        <div className="flex flex-col items-center">
          <Diamond label="CHARGING & 배터리 ≥ 80%?" cls={CLS.decision} />
          <Arrow label="예" />
          <Node label="IDLE (충전 종료) + Alert.charged" cls={CLS.start} wide
                impl="reconcileChargingStatus · CHARGE_TARGET_PCT=80 · 진행 태스크 없을 때만 (명시적 방전도 IDLE)" />
        </div>
        {/* 전복 */}
        <div className="flex flex-col items-center">
          <Diamond label="IMU roll/pitch > 45°?" cls={CLS.decision} />
          <Arrow label="예" />
          <Node label="ERROR + 진행 RUNNING→FAILED 재등록" cls={CLS.warning} wide
                impl="onImu · FALL_THRESH_RAD=π/4 · 그 외 PENDING은 글로벌 큐 반납 · 자세 복구 시 IDLE" />
        </div>
        {/* 오프라인 */}
        <div className="flex flex-col items-center">
          <Diamond label="6초 무수신?" cls={CLS.decision} />
          <Arrow label="예" />
          <Node label="OFFLINE + 진행분 FAILED" cls={CLS.warning} wide
                impl="OFFLINE_AFTER_MS=6000 · handleOfflineTransition · 복귀 시 online" />
        </div>
      </div>
    </div>
  );
}

/* ── 메인 뷰: 중앙 서브 nav로 차트 전환 ───────────────────── */
const CHARTS = [
  { id: "workflow", label: "태스크 워크플로우", title: "태스크 워크플로우 (생성 → 배정 → 실행 → 완료)" },
  { id: "dispatch", label: "타입별 처리",       title: "태스크 타입별 처리 (dispatch 분기)" },
  { id: "auto",     label: "자동 배정",         title: "자동 배정 · 적합 로봇 선정 (AutoDispatcher)" },
  { id: "monitor",  label: "상태·충전 모니터",  title: "상태 · 충전 모니터링 (2초 tick)" },
] as const;
type ChartId = typeof CHARTS[number]["id"];

export default function FlowView() {
  const [chart, setChart] = useState<ChartId>("workflow");
  const active = CHARTS.find((c) => c.id === chart)!;

  return (
    <div className="h-full overflow-auto bg-transparent p-6">
      <div className="max-w-6xl mx-auto">
        {/* 중앙 서브 nav — 차트 선택 */}
        <div className="flex justify-center mb-5">
          <div className="flex bg-[#FFCE99]/32 backdrop-blur-xl p-1 rounded-xl border border-white/[0.1] shadow-inner">
            {CHARTS.map((c) => (
              <button key={c.id} onClick={() => setChart(c.id)}
                className={`px-5 py-2 text-xs font-semibold tracking-widest rounded-lg whitespace-nowrap transition-all duration-300 ${
                  chart === c.id
                    ? "bg-orange-500/15 text-orange-600 border border-orange-500/30 shadow-sm"
                    : "text-white/[0.55] hover:text-white/[0.75] hover:bg-[#FFCE99]/32 border border-transparent"
                }`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6 text-center">
          <h1 className="text-lg font-bold text-white">{active.title}</h1>
          <p className="text-xs text-white/[0.75] mt-1">노드에 마우스를 올리면 실제 코드 위치가 표시됩니다 · <span className="text-amber-600">예정</span> = 설계상 존재, 미연결·구현 진행 중</p>
        </div>

        <div className="flex justify-center">
          {chart === "workflow" && <WorkflowChart />}
          {chart === "dispatch" && <DispatchChart />}
          {chart === "auto"     && <AutoDispatchChart />}
          {chart === "monitor"  && <MonitorChart />}
        </div>
      </div>
    </div>
  );
}
