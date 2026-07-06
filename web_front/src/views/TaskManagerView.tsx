import { useState, useEffect, useCallback, useMemo } from "react";
import type { RosMessage, FmsTask, TaskManagerAlert, RobotInfo } from "../hooks/useNestSocket";
import { BACKEND_URL } from "../config";
import { OPERATIONAL_ROBOTS as ROBOTS } from "../robots"; // 운영 화면 — 가상 테스트봇 제외
import { useTopoNodes } from "../hooks/useTopoNodes";
import { isOnline, computeNearest } from "./taskmanager/helpers";
import { RobotMonitorCard } from "./taskmanager/components";
import { TaskMiniCard } from "../components/GlobalTaskQueueBar";
import { robotStatusKo, robotStatusColor } from "../utils/statusLabel";
import { batteryPercent } from "../utils/battery";

// AI 챗봇은 전역 플로팅 버튼(<AiAssistant/>, App에서 렌더)이 담당 — 이 화면엔 따로 두지 않는다.

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  emitFmsAutoCharge: (robotId: string) => void;
  robotStatuses: Record<string, string>;
  tmAlerts: TaskManagerAlert[];
  robots: RobotInfo[];
  onSelectRobotInFleet: (robotId: string) => void;
}

const ROBOT_IDS = ROBOTS.map(r => r.id);

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────
export default function TaskManagerView({
  rosMessages, fmsTasks, emitFmsAutoCharge,
  robotStatuses, tmAlerts, robots, onSelectRobotInFleet,
}: Props) {

  // 글로벌 큐와 동일하게 — 백엔드 REST 호출만, 화면은 소켓으로 갱신
  const dispatch = async (taskId: string, robotId: string) => {
    if (!robotId) return;
    try { await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}/dispatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ robotId }) }); }
    catch { /* 무시 */ }
  };
  const remove = async (taskId: string) => {
    try { await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}`, { method: "DELETE" }); }
    catch { /* 무시 */ }
  };
  const resume = async (taskId: string) => {
    try { await fetch(`${BACKEND_URL}/api/fms/tasks/${taskId}/resume`, { method: "POST" }); }
    catch { /* 무시 */ }
  };

  const [robotSearch, setRobotSearch] = useState("");
  const topoNodes = useTopoNodes();
  const getNearestNode = useCallback((x: number, y: number) => computeNearest(x, y, topoNodes), [topoNodes]);

  // 경과 시간/배터리 등 표시 갱신용 주기 리렌더
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 2000); return () => clearInterval(id); }, []);

  const visibleRobots = useMemo(() => {
    if (!robotSearch.trim()) return ROBOTS;
    const q = robotSearch.toLowerCase();
    return ROBOTS.filter(r => r.id.toLowerCase().includes(q) || String(r.domain).includes(q));
  }, [robotSearch]);

  // 로봇별 현재 수행 / 다음 예정(큐 seq 순) — 글로벌 큐 카드로 표시
  const robotBoards = useMemo(() => ROBOTS.map(r => {
    const mine    = fmsTasks.filter(t => t.assignedRobotId === r.id || t.preferredRobotId === r.id);
    const current = mine.find(t => ["RUNNING", "ASSIGNED", "SUSPENDED"].includes(t.status)) ?? null;
    const next    = mine
      .filter(t => t.status === "PENDING")
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;
    return { robot: r, current, next };
  }), [fmsTasks]);
  // 온라인이거나 진행/예정 작업이 있는 로봇만 노출
  const shownBoards = robotBoards.filter(b => isOnline(robotStatuses, b.robot.id) || b.current || b.next);

  const handleCharge = useCallback((robotId: string) => { emitFmsAutoCharge(robotId); }, [emitFmsAutoCharge]);

  const onlineCount = ROBOTS.filter(r => isOnline(robotStatuses,r.id)).length;

  return (
    <div className="relative flex flex-col h-full bg-transparent overflow-hidden">

      {/* ── 2컬럼 본문: 로봇 모니터 | 로봇별 작업 현황 (상단 통계바 제거됨) ── */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">

        {/* ══ 왼쪽: 로봇 모니터 ════════════════════════════════════════════ */}
        <div className="w-full md:w-80 flex-none flex flex-col border-b md:border-b-0 md:border-r border-white/[0.1] bg-[#FFCE99]/32 max-h-[45vh] md:max-h-none">
          <div className="flex-none px-4 pt-3.5 pb-3 border-b border-white/[0.1]">
            <div className="flex items-center justify-between mb-2.5">
              <div>
                <span className="sub-label">로봇 모니터</span>
                <div className="text-xs font-semibold text-white/[0.82] tracking-wide mt-0.5">온라인 {onlineCount} / {ROBOTS.length}</div>
              </div>
            </div>
            <div className="relative">
              <input value={robotSearch} onChange={e => setRobotSearch(e.target.value)} placeholder="로봇 검색 (id · domain)..."
                className="w-full bg-[#FFCE99]/14 border border-white/[0.1] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white/[0.75] placeholder:text-white/[0.4] focus:outline-none focus:border-white/[0.08]" />
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/[0.45]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {visibleRobots.length === 0 ? (
              <div className="flex items-center justify-center h-full text-white/[0.4] text-xs">검색 결과 없음</div>
            ) : visibleRobots.map(r => {
              const online  = isOnline(robotStatuses,r.id);
              const status  = robotStatuses[r.id];
              const task    = fmsTasks.find(t => t.assignedRobotId === r.id && ["ASSIGNED", "RUNNING"].includes(t.status));
              const dbInfo  = robots.find(ri => ri.robot_id === r.id);
              const batRos  = (rosMessages[`/${r.id}/battery_state`]?.data as any)?.percentage;
              // raw(글리치 가능) 우선, 무효면 DB값으로 폴백 — 둘 다 범위검증/클램프
              const batPct  = batteryPercent(batRos) ?? batteryPercent(dbInfo?.battery);
              const amclPos = (rosMessages[`/${r.id}/amcl_pose`]?.data as any)?.pose?.pose?.position;
              const odomPos = (rosMessages[`/${r.id}/odom`]?.data as any)?.pose?.pose?.position;
              const posX    = amclPos?.x ?? odomPos?.x ?? dbInfo?.pose_x;
              const posY    = amclPos?.y ?? odomPos?.y ?? dbInfo?.pose_y;
              const nodeId  = (posX != null && posY != null) ? getNearestNode(posX, posY) : (dbInfo?.lastNode ?? null);
              return (
                <RobotMonitorCard key={r.id} robot={r} online={online} status={status} task={task}
                  batPct={batPct} nodeId={nodeId} onCharge={() => handleCharge(r.id)} onClick={() => onSelectRobotInFleet(r.id)} />
              );
            })}
          </div>
        </div>

        {/* ══ 오른쪽: 로봇별 작업 현황 (현재 / 다음만, 글로벌 큐 카드) ═════ */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-none px-5 pt-3.5 pb-3 border-b border-white/[0.1]">
            <span className="sub-label">로봇별 작업 현황</span>
            <div className="text-xs text-white/[0.5] mt-0.5">현재 수행 중 · 다음 예정 작업만 표시</div>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {shownBoards.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="text-4xl mb-4 opacity-10">◻</div>
                <p className="text-sm text-white/[0.4] tracking-wide">작업 중인 로봇이 없습니다</p>
              </div>
            ) : shownBoards.map(({ robot: r, current, next }) => {
              const online = isOnline(robotStatuses, r.id);
              const lbl = online ? robotStatusKo(robotStatuses[r.id] ?? "IDLE") : "오프라인";
              const lblColor = !online ? "text-white/[0.4]" : robotStatusColor(robotStatuses[r.id]);
              return (
                <div key={r.id} className="rounded-xl bg-[#FFCE99]/14 border border-white/[0.1] p-3">
                  {/* 로봇 헤더 */}
                  <div className="flex items-center gap-2 mb-2.5">
                    <div className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400" : "bg-[#521C0D]/30"}`} />
                    <span className="text-sm font-bold font-mono text-white/90">{r.id}</span>
                    <span className={`text-[10px] font-bold tracking-wide ${lblColor}`}>{lbl}</span>
                  </div>
                  {/* 현재 / 다음 카드 (글로벌 태스크 큐와 동일 UI) */}
                  <div className="flex gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold tracking-widest text-emerald-300/80 uppercase mb-1 pl-0.5">현재 수행</div>
                      {current
                        ? <TaskMiniCard task={current} robots={ROBOT_IDS} onDispatch={dispatch} onDelete={remove} onResume={resume} widthClass="w-full" />
                        : <EmptySlot text="수행 중 작업 없음" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold tracking-widest text-amber-300/80 uppercase mb-1 pl-0.5">다음 예정</div>
                      {next
                        ? <TaskMiniCard task={next} robots={ROBOT_IDS} onDispatch={dispatch} onDelete={remove} onResume={resume} widthClass="w-full" />
                        : <EmptySlot text="예정 작업 없음" />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}

// 빈 슬롯 — 카드 자리 (글로벌 큐 카드 높이와 맞춤)
function EmptySlot({ text }: { text: string }) {
  return (
    <div className="w-full rounded-xl border border-dashed border-white/[0.12] bg-white/[0.02] p-2.5 flex items-center justify-center text-[11px] text-white/30 min-h-[112px]">
      {text}
    </div>
  );
}
