import { useState } from "react";
import type { FmsTask, RosPlanStep } from "../../hooks/useNestSocket";
import { taskTypeKo, taskStatusKo } from "../../utils/statusLabel";
import { type RankedRobot, fetchRobotRanking } from "../../utils/robotRanking";
import { TYPE_COLOR, statusPill, statusDot, cardBorder, robotIcon, fmtDateTime } from "./shared";
import { Dropdown, rankingToOptions } from "./Dropdown";
import { isTestBot } from "../../robots";
import { useTestBots } from "../../context/testbots";

// 커스텀 태스크 스텝(단계) 표시
const STEP_KO: Record<string, string> = { move: "이동", service: "서비스", action: "액션", topic: "토픽", wait: "대기", supply: "보급" };
const STEP_DOT: Record<string, string> = { move: "bg-sky-400", service: "bg-rose-400", action: "bg-fuchsia-400", topic: "bg-violet-400", wait: "bg-amber-400", supply: "bg-emerald-400" };
function stepLabel(s: RosPlanStep): string {
  const kind = s.kind ?? "move";
  if (kind === "move") return `이동 ${s.awaitNodeId ?? ""}`.trim();
  if (kind === "wait") return s.awaitKind === "signal" ? "대기 신호" : `대기 ${s.waitMs ?? 0}ms`;
  const suffix = (s.topicName ?? "").replace(/^\/[^/]+\//, "").replace(/^\//, ""); // /robot/ or /tb3_01/ 제거
  return `${STEP_KO[kind] ?? kind} ${suffix}`.trim();
}

export function TaskMiniCard({ task: t, robots, onDispatch, onDelete, onResume, widthClass = "w-[calc((100%_-_2rem)/5)] min-w-[200px]" }: { task: FmsTask; robots: string[]; onDispatch: (taskId: string, robotId: string) => void; onDelete: (taskId: string) => void; onResume: (taskId: string) => void; widthClass?: string }) {
  const canDelete = t.status === "DRAFT" || t.status === "PENDING"; // 대기 상태만 삭제 가능
  const [robotSel, setRobotSel] = useState(t.preferredRobotId && t.preferredRobotId !== "null" ? t.preferredRobotId : "");
  const [ranking, setRanking] = useState<RankedRobot[]>([]); // 드롭다운 펼칠 때 그 태스크 기준 추천
  const { showTestBots } = useTestBots();
  const elapsed = t.startedAt && !t.completedAt ? Math.floor((Date.now() - new Date(t.startedAt).getTime()) / 1000) : null;
  const full = t.fullPath?.length ?? 0;
  const remain = t.pathQueue?.length ?? 0;
  const done = Math.max(0, full - remain);
  const showProgress = t.status === "RUNNING" && full > 0;
  const cursor = t.rosCursor ?? 0; // 현재/실패 스텝 인덱스

  return (
    <div className={`flex-none ${widthClass} rounded-xl bg-white/[0.05] border ${cardBorder(t.status)} p-2.5 flex flex-col gap-2`}>
      {/* 유형(진한 배지) + 상태 */}
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-extrabold tracking-wide px-2 py-0.5 rounded-md ${t.label ? "bg-violet-500 text-white" : (TYPE_COLOR[t.type] ?? "bg-white/20 text-white")}`}>{t.label ? "🧱 커스텀" : taskTypeKo(t.type)}</span>
        <div className="flex items-center gap-1">
          <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold ${statusPill(t.status)}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot(t.status)}`} />
            {taskStatusKo(t.status)}
          </span>
          {/* 대기(PENDING/DRAFT) 태스크만 DB에서 삭제 */}
          {canDelete && (
            <button onClick={() => onDelete(t._id)} title="삭제 (대기 태스크)"
              className="flex-none w-4 h-4 flex items-center justify-center rounded text-white/45 hover:text-white hover:bg-rose-500/50 text-[11px] leading-none transition-colors">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 커스텀 태스크 = 저장 이름 + 단계 전부 / 기본 유형 = 목적지(복귀=초기위치, 일시정지=현재 위치) */}
      {t.label ? (
        <div>
          <div className="text-[13px] font-bold text-white/90 truncate" title={t.label}>{t.label}</div>
          {t.rosPlan && t.rosPlan.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {t.rosPlan.map((s, i) => {
                const failed = t.status === "FAILED" && i === cursor;   // 이 스텝에서 에러
                const current = t.status === "RUNNING" && i === cursor; // 진행 중
                const done = t.status === "COMPLETED" || i < cursor; // 지나간(완료) 스텝
                return (
                  <span key={i} title={stepLabel(s)}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] ${
                      failed ? "bg-rose-500/30 border-rose-400/60 text-rose-100 font-bold"
                        : current ? "bg-amber-400/25 border-amber-300/60 text-white"
                        : done ? "bg-white/[0.03] border-white/[0.06] text-white/35"
                        : "bg-white/[0.06] border-white/[0.08] text-white/70"}`}>
                    <span className="font-bold opacity-80">{failed ? "⚠" : done ? "✓" : i + 1}</span>
                    {!failed && !done && <span className={`w-1.5 h-1.5 rounded-full ${current ? "bg-amber-300 animate-pulse" : STEP_DOT[s.kind ?? "move"] ?? "bg-white/30"}`} />}
                    {stepLabel(s)}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="font-mono text-[13px] text-white/85 truncate" title={t.targetNode}>→ {t.type === "RECALL" && !t.targetNode ? "초기위치" : t.type === "PAUSE" ? "현재 위치" : t.targetNode}</div>
      )}

      {/* 수행 로봇 — 종류별 아이콘 + 큰 ID(고대비) */}
      {t.assignedRobotId ? (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-emerald-500/25 border border-emerald-400/50">
          <span className="text-xl leading-none flex-none">{robotIcon(t.assignedRobotId)}</span>
          <span className="font-mono font-extrabold text-[15px] text-white truncate">{t.assignedRobotId}</span>
          <span className="text-[10px] font-extrabold text-black bg-emerald-400 px-1.5 py-0.5 rounded ml-auto flex-none whitespace-nowrap">수행</span>
        </div>
      ) : t.preferredRobotId && t.preferredRobotId !== "null" ? (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-sky-500/20 border border-sky-400/45">
          <span className="text-xl leading-none flex-none">{robotIcon(t.preferredRobotId)}</span>
          <span className="font-mono font-extrabold text-[15px] text-white truncate">{t.preferredRobotId}</span>
          <span className="text-[10px] font-extrabold text-black bg-sky-400 px-1.5 py-0.5 rounded ml-auto flex-none whitespace-nowrap">대기</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.1]">
          <span className="text-xl leading-none flex-none opacity-30">🤖</span>
          <span className="text-[12px] font-bold text-white/60">로봇 미지정</span>
        </div>
      )}

      {/* 하단: 진행/사유/시간 (실패 사유 텍스트는 표시 안 함 — DB에만 저장. 멈춘 단계만 빨갛게) */}
      <div className="mt-auto min-w-0">
        {showProgress ? (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-400/70 rounded-full" style={{ width: `${(done / full) * 100}%` }} />
            </div>
            <span className="text-[10px] text-white/70 font-mono font-semibold flex-none">{done}/{full}</span>
          </div>
        ) : t.waitReason ? (
          <span className="text-[10px] text-dark-200 font-semibold italic truncate block" title={t.waitReason}>{t.waitReason}</span>
        ) : (
          <span className="text-[11px] text-white/70 font-mono font-semibold flex items-center gap-1">
            <span className="opacity-60">🕒</span>
            {elapsed !== null ? `${elapsed}초 경과` : fmtDateTime(t.createdAt)}
          </span>
        )}
      </div>

      {/* SUSPENDED(일시정지 보류): 들고 있던 큐를 그 지점부터 재개 */}
      {t.status === "SUSPENDED" && (
        <button onClick={() => onResume(t._id)}
          className="w-full px-2.5 py-1 text-[11px] font-extrabold rounded-lg bg-pink-500 text-white border border-pink-300/50 hover:bg-pink-400">
          ▶ 재개
        </button>
      )}

      {/* DRAFT/PENDING: 로봇 지정 → 할당. 충전·복귀·일시정지는 등록 시 로봇이 정해지므로 선택 없이 수행 버튼만. */}
      {(t.status === "DRAFT" || t.status === "PENDING") && (
        <div className="flex items-center gap-1 pt-0.5">
          {t.type === "CHARGE" || t.type === "RECALL" || t.type === "PAUSE" ? (
            <button disabled={!t.preferredRobotId || t.preferredRobotId === "null"} onClick={() => onDispatch(t._id, t.preferredRobotId!)}
              className="flex-1 px-2.5 py-1 text-[11px] font-extrabold rounded-lg bg-sky-500 text-white border border-sky-300/50 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed">
              수행
            </button>
          ) : (
            <>
              <Dropdown value={robotSel} onChange={setRobotSel} title="할당할 로봇 (추천순)" className="flex-1 min-w-0"
                menuHeader={ranking.length ? "추천순 · 온라인 → 배터리40%↑ → 대기 → 근접" : undefined}
                onOpen={() => void fetchRobotRanking(t.targetNode, t.type).then(setRanking)}
                options={[{ value: "", label: "추천 로봇" }, ...(ranking.length
                  ? rankingToOptions(ranking, t.type === "SUPPLY", showTestBots)
                  : robots.filter((r) => (showTestBots || !isTestBot(r)) && (t.type === "SUPPLY" ? r.startsWith("omx") : !r.startsWith("omx"))).map((r) => ({ value: r, label: r })))]} />
              <button disabled={!robotSel} onClick={() => onDispatch(t._id, robotSel)}
                className="flex-none px-2.5 py-1 text-[11px] font-extrabold rounded-lg bg-sky-500 text-white border border-sky-300/50 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed">
                할당
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
