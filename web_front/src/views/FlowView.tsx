import React from "react";

/* ── 색상 클래스 ─────────────────────────────────────────── */
const CLS = {
  start:    "bg-emerald-700/70 border-emerald-400/80 text-emerald-100",
  process:  "bg-blue-700/70   border-blue-400/80   text-blue-100",
  decision: "bg-amber-600/70  border-amber-400/80  text-amber-100",
  warning:  "bg-red-700/60    border-red-400/80    text-red-100",
  wait:     "bg-[#521C0D]/15  border-slate-400/60  text-[#521C0D] border-dashed",
};

const IMPL_MAP: Record<string, string> = {
  "작업 큐 삽입":       "TaskManagerService.enqueue() → FmsService.createQueued()",
  "로봇 가용성 확인":   "process() — robotCache.lastSeen < 5s & status=IDLE",
  "배터리 확인":        "robotCache.batteryPct (구현 예정 — 현재 캐시만 수집)",
  "로봇 상태 확인":     "robot.status === IDLE 체크",
  "작업 할당":          "fmsService.assignToRobotId() + updateStatus(MOVING)",
  "상태 모니터링":      "tick() 2s: syncOnlineStatus + checkAmclTimeout + checkWaypointArrival",
  "오프라인 감지":      "lastSeen > 20s → setOffline() + updateLocation(null) → FAILED",
  "완료":               "checkWaypointArrival() isFinal → COMPLETED → IDLE → 홈 귀환",
  "관제 알림":          "server.emit('task_manager_alert')",
};

/* ── 기본 노드 컴포넌트 ──────────────────────────────────── */
function Node({
  label, cls, step, impl, wide,
}: { label: string; cls: string; step?: number; impl?: string; wide?: boolean }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className="relative flex flex-col items-center">
      <div
        className={`border rounded-xl px-4 py-2 text-sm font-medium text-center cursor-default
                    transition-all duration-200 ${cls}
                    ${wide ? "min-w-[200px]" : "min-w-[160px]"}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {step && (
          <span className="text-[10px] font-bold text-white/[0.82] mr-1">#{step}</span>
        )}
        {label}
      </div>
      {/* 호버 tooltip — 코드 위치 */}
      {hover && impl && (
        <div className="absolute top-full mt-2 z-50 bg-[#FFFDF1] border border-white/[0.12]
                        rounded-lg px-3 py-2 text-[11px] text-[#521C0D]/70 whitespace-nowrap
                        shadow-2xl pointer-events-none">
          <span className="text-white/[0.6] mr-1">impl:</span>{impl}
        </div>
      )}
    </div>
  );
}

/* ── 마름모 결정 노드 ────────────────────────────────────── */
function Diamond({ label, cls }: { label: string; cls: string }) {
  return (
    <div className={`border-2 rounded-lg px-5 py-2 text-sm font-semibold text-center
                     transform rotate-[0deg] ${cls} min-w-[180px]`}>
      {label}
    </div>
  );
}

/* ── 화살표 ──────────────────────────────────────────────── */
function Arrow({ label, dir = "down" }: { label?: string; dir?: "down" | "left" | "right" }) {
  if (dir === "down") {
    return (
      <div className="flex flex-col items-center my-0.5">
        {label && <span className="text-[10px] text-white/[0.82] mb-0.5">{label}</span>}
        <div className="w-px h-5 bg-white/40" />
        <div className="w-0 h-0 border-l-4 border-r-4 border-t-6
                        border-l-transparent border-r-transparent border-t-white/60" />
      </div>
    );
  }
  return null;
}

/* ── 점선 귀환 선 표시 ────────────────────────────────────── */
function DashLoop({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 my-1 px-3 py-1 border border-dashed border-white/30
                    rounded-lg text-[10px] text-white/[0.75]">
      <span className="text-white/[0.6]">↩</span> {label}
    </div>
  );
}

/* ── 메인 뷰 ─────────────────────────────────────────────── */
export default function FlowView() {
  return (
    <div className="h-full overflow-auto bg-transparent p-6">
      <div className="max-w-5xl mx-auto">

        {/* 헤더 */}
        <div className="mb-6">
          <h1 className="text-lg font-bold text-white">FMS 태스크 처리 워크플로우</h1>
          <p className="text-xs text-white/[0.75] mt-1">
            노드에 마우스를 올리면 실제 코드 위치가 표시됩니다
          </p>
        </div>

        <div className="flex gap-8">
          {/* ── 메인 플로우 ── */}
          <div className="flex flex-col items-center flex-1">

            {/* 1. 트리거 */}
            <Node label="상황 및 이벤트 발생" cls={CLS.start} />
            <Arrow />

            {/* 2. 큐 삽입 */}
            <Node label="작업 큐 삽입 & 우선순위 결정" cls={CLS.process} step={1}
                  impl={IMPL_MAP["작업 큐 삽입"]} wide />
            <Arrow />

            {/* 3. 작업 가능 여부 */}
            <Diamond label="최우선 작업 수행 가능?" cls={CLS.decision} />
            <div className="flex w-full justify-center gap-8 mt-1">
              <div className="flex flex-col items-center">
                <Arrow label="No" />
                <Node label="관제 알림 (AlertTower)" cls={CLS.warning}
                      impl={IMPL_MAP["관제 알림"]} />
                <DashLoop label="운영자 조치 후 재시도" />
              </div>
              <div className="flex flex-col items-center">
                <Arrow label="Yes" />

                {/* 4. 로봇 확인 */}
                <Diamond label="IDLE 로봇 있음?" cls={CLS.decision} />
                <div className="flex gap-6 mt-1">
                  <div className="flex flex-col items-center">
                    <Arrow label="No" />
                    <Node label="작업 대기 (PENDING)" cls={CLS.wait} />
                    <DashLoop label="2s tick 재확인" />
                  </div>
                  <div className="flex flex-col items-center">
                    <Arrow label="Yes" />

                    {/* 5. 배터리 */}
                    <Diamond label="배터리 충분? (≥20%)" cls={CLS.decision} />
                    <div className="flex gap-4 mt-1">
                      <div className="flex flex-col items-center">
                        <Arrow label="No" />
                        <Node label="충전 요구 알림" cls={CLS.warning} />
                        <DashLoop label="다른 로봇 탐색" />
                      </div>
                      <div className="flex flex-col items-center">
                        <Arrow label="Yes" />

                        {/* 6. 상태 확인 */}
                        <Diamond label="로봇 상태 적합?" cls={CLS.decision} />
                        <div className="flex gap-4 mt-1">
                          <div className="flex flex-col items-center">
                            <Arrow label="No" />
                            <Node label="관제 알림" cls={CLS.warning}
                                  impl={IMPL_MAP["관제 알림"]} />
                            <DashLoop label="운영자 조치" />
                          </div>
                          <div className="flex flex-col items-center">
                            <Arrow label="Yes" />

                            {/* 7. 할당 */}
                            <Node label="작업 할당 & 경로탐색(A*)" cls={CLS.process} step={6}
                                  impl={IMPL_MAP["작업 할당"]} wide />
                            <Arrow />

                            {/* 8. 모니터링 */}
                            <Node label="작업 상태 모니터링" cls={CLS.process} step={7}
                                  impl={IMPL_MAP["상태 모니터링"]} wide />
                            <Arrow />

                            {/* 9. 에러 */}
                            <Diamond label="에러 발생?" cls={CLS.decision} />
                            <div className="flex gap-4 mt-1">
                              <div className="flex flex-col items-center">
                                <Arrow label="Yes" />
                                <Node label="관제 조치" cls={CLS.warning} />
                                <DashLoop label="재시도 또는 취소" />
                              </div>
                              <div className="flex flex-col items-center">
                                <Arrow label="No" />
                                <Node label="작업 완료 & 홈 복귀" cls={CLS.start} step={9}
                                      impl={IMPL_MAP["완료"]} wide />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── 사이드 패널: 코드 매핑 & 구현 현황 ── */}
          <div className="w-72 flex-none space-y-3">
            <div className="bg-[#FFCE99]/14 border border-white/[0.08] rounded-xl p-4">
              <h3 className="text-xs font-bold text-white/80 uppercase tracking-widest mb-3">구현 현황</h3>
              {[
                { label: "작업 큐 삽입",      done: true  },
                { label: "로봇 가용성 확인",   done: true  },
                { label: "배터리 확인",        done: false },
                { label: "로봇 상태 확인",     done: true  },
                { label: "작업 할당 & 경로",   done: true  },
                { label: "위치 추적 모니터링", done: true  },
                { label: "오프라인 20s 감지",  done: true  },
                { label: "전복 감지",          done: true  },
                { label: "완료 & 홈 복귀",     done: true  },
              ].map(({ label, done }) => (
                <div key={label} className="flex items-center gap-2 py-1.5 border-b border-white/[0.1] last:border-0">
                  <span className={`text-xs font-bold ${done ? "text-emerald-600" : "text-amber-600"}`}>
                    {done ? "✓" : "○"}
                  </span>
                  <span className={`text-xs ${done ? "text-white/90" : "text-amber-800/90"}`}>{label}</span>
                  {!done && (
                    <span className="ml-auto text-[9px] bg-amber-500/15 text-amber-600 px-1.5 py-0.5 rounded">예정</span>
                  )}
                </div>
              ))}
            </div>

            <div className="bg-[#FFCE99]/14 border border-white/[0.08] rounded-xl p-4">
              <h3 className="text-xs font-bold text-white/80 uppercase tracking-widest mb-3">타임아웃 설정</h3>
              {[
                ["오프라인 판정",   "20s"],
                ["AMCL 타임아웃",  "20s"],
                ["Tick 주기",       "2s"],
                ["코너 정지 대기",  "2s"],
                ["코너 안전 한계",  "8s"],
                ["노드 통과 반경",  "1.5m"],
                ["목적지 도달 반경","0.5m"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between py-1 border-b border-white/[0.1] last:border-0">
                  <span className="text-xs text-white/[0.82]">{k}</span>
                  <span className="text-xs font-mono text-cyan-600">{v}</span>
                </div>
              ))}
            </div>

            <div className="bg-[#FFCE99]/14 border border-white/[0.08] rounded-xl p-4">
              <h3 className="text-xs font-bold text-white/80 uppercase tracking-widest mb-3">로봇 상태</h3>
              {[
                ["IDLE",    "대기 중 (배정 가능)", "text-emerald-600"],
                ["MOVING",  "이동 중",             "text-blue-600"],
                ["WORKING", "작업 중",             "text-violet-600"],
                ["ERROR",   "오류 상태",           "text-red-600"],
                ["OFFLINE", "연결 끊김",           "text-slate-500"],
              ].map(([status, desc, color]) => (
                <div key={status} className="flex items-center gap-2 py-1 border-b border-white/[0.1] last:border-0">
                  <span className={`text-xs font-mono font-bold ${color}`}>{status}</span>
                  <span className="text-xs text-white/[0.82]">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
