import { useState, useMemo } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, FmsTask, FmsDispatchPayload, TaskType } from "../hooks/useNestSocket";
import NavMapCanvas from "../components/NavMapCanvas";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const ROBOTS = [
  { id: "vicpinky", label: "VICPINKY",  domain: 40, type: "carrier" },
  { id: "tb3_01",   label: "TB3-01",    domain: 41, type: "tb3"     },
  { id: "tb3_02",   label: "TB3-02",    domain: 42, type: "tb3"     },
  { id: "tb3_03",   label: "TB3-03",    domain: 43, type: "tb3"     },
  { id: "tb3_04",   label: "TB3-04",    domain: 44, type: "tb3"     },
  { id: "omx",      label: "OMX ARM",   domain: 45, type: "arm"     },
] as const;

const TASK_LABELS: Record<TaskType, string> = {
  explore:       "탐사",
  deliver:       "수송",
  stop:          "정지",
  diagnose:      "진단",
  carrier_task:  "배송 태스크",
  emergency_stop:"긴급정지",
};

const STATUS_STYLE: Record<string, string> = {
  queued:    "text-amber-400 border-amber-900/50 bg-amber-950/20",
  active:    "text-blue-400  border-blue-900/50  bg-blue-950/20",
  completed: "text-green-500 border-green-900/50 bg-green-950/20",
  failed:    "text-red-500   border-red-900/50   bg-red-950/20",
  cancelled: "text-[#444]    border-[#1a1a1a]    bg-transparent",
};

const STATUS_DOT: Record<string, string> = {
  queued:    "bg-amber-400",
  active:    "bg-blue-400 animate-pulse",
  completed: "bg-green-500",
  failed:    "bg-red-500",
  cancelled: "bg-[#333]",
};

const ONLINE_THRESHOLD_MS = 5000;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  socket:             Socket | null;
  emitFmsDispatch:    (p: FmsDispatchPayload) => void;
  emitFmsCancel:      (taskId: string) => void;
  emitNavGoal:        (robotId: string, x: number, y: number, yaw: number) => void;
  emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number) => void;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
  const topics =
    robotId === "vicpinky" ? ["/vicpinky/odom", "/vicpinky/scan"] :
    robotId === "omx"      ? ["/omx/joint_states"]                :
    [`/${robotId}/odom`, `/${robotId}/scan`];
  const now = Date.now();
  return topics.some((t) => {
    const msg = rosMessages[t];
    return msg && now - msg.timestamp < ONLINE_THRESHOLD_MS;
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)  return `${Math.floor(diff / 1000)}초 전`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return `${Math.floor(diff / 3600000)}시간 전`;
}

// ── 로봇 카드 ─────────────────────────────────────────────────────────────────

function RobotCard({
  robot, rosMessages, fmsTasks, onDispatch,
}: {
  robot: typeof ROBOTS[number];
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  onDispatch: (type: TaskType, targetId?: string) => void;
}) {
  const { id, label, domain, type } = robot;
  const online = isOnline(rosMessages, id);

  const p = (topic: string) => rosMessages[`/${id}/${topic}`]?.data;

  // tb3 전용
  const mode    = (p("mode") as { data?: string } | undefined)?.data ?? "unknown";
  const batData = p("battery_state") as { percentage?: number; voltage?: number } | undefined;
  const batPct  = batData?.percentage != null
    ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
    : null;
  const detected = (p("yolo/person_detected") as { data?: boolean } | undefined)?.data ?? false;
  const odomData = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number } } } } | undefined;
  const pos      = odomData?.pose?.pose?.position;

  // vicpinky 전용
  const vpOdom = rosMessages["/vicpinky/odom"]?.data as { pose?: { pose?: { position?: { x?: number; y?: number } } } } | undefined;
  const vpPos  = vpOdom?.pose?.pose?.position;

  // omx 전용
  const jsData  = p("joint_states") as { velocity?: number[] } | undefined;
  const omxMoving = jsData?.velocity?.some((v) => Math.abs(v) > 0.01) ?? false;

  // 활성 태스크
  const activeTasks = fmsTasks.filter(
    (t) => t.robotId === id && (t.status === "active" || t.status === "queued"),
  );
  const activeTask = activeTasks[0];

  const modeColor =
    mode === "explore" ? "text-blue-400" :
    mode === "deliver" ? "text-amber-400" :
    mode === "stop"    ? "text-red-400"   : "text-[#444]";

  return (
    <div className={`flex flex-col gap-3 p-3 border transition-all ${
      online
        ? "border-red-900/40 bg-[#0a0a0a]"
        : "border-[#1a1a1a] bg-[#060606] opacity-60"
    }`}>
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full flex-none ${online ? "bg-green-500 animate-pulse" : "bg-[#333]"}`} />
          <span className="text-[11px] font-black tracking-widest uppercase font-mono text-[#c0c0c0]">
            {label}
          </span>
        </div>
        <span className="text-[9px] font-mono text-[#333] border border-[#1a1a1a] px-1.5 py-0.5">
          D:{domain}
        </span>
      </div>

      {/* 상태 정보 */}
      <div className="flex flex-col gap-1 text-[10px] font-mono min-h-[52px]">
        {type === "tb3" && (
          <>
            <div className="flex justify-between">
              <span className="text-[#444]">MODE</span>
              <span className={`font-bold uppercase ${modeColor}`}>{mode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#444]">BAT</span>
              <span className={`font-bold ${
                batPct == null ? "text-[#333]" :
                batPct < 20 ? "text-red-500" :
                batPct < 50 ? "text-amber-400" : "text-green-500"
              }`}>{batPct != null ? `${batPct}%` : "—"}</span>
            </div>
            {pos && (
              <div className="flex justify-between">
                <span className="text-[#444]">POS</span>
                <span className="text-[#888]">{(pos.x ?? 0).toFixed(1)}, {(pos.y ?? 0).toFixed(1)}</span>
              </div>
            )}
            {detected && (
              <div className="text-red-500 font-black danger-pulse text-center">⚠ PERSON</div>
            )}
          </>
        )}

        {type === "carrier" && (
          <>
            {vpPos && (
              <>
                <div className="flex justify-between">
                  <span className="text-[#444]">X</span>
                  <span className="text-[#888]">{(vpPos.x ?? 0).toFixed(2)} m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#444]">Y</span>
                  <span className="text-[#888]">{(vpPos.y ?? 0).toFixed(2)} m</span>
                </div>
              </>
            )}
          </>
        )}

        {type === "arm" && (
          <div className="flex justify-between">
            <span className="text-[#444]">MOTION</span>
            <span className={omxMoving ? "text-blue-400 font-bold" : "text-[#333]"}>
              {omxMoving ? "MOVING" : "IDLE"}
            </span>
          </div>
        )}
      </div>

      {/* 활성 태스크 */}
      <div className="h-6 flex items-center">
        {activeTask ? (
          <span className={`text-[9px] font-mono px-1.5 py-0.5 border font-bold uppercase tracking-wider ${STATUS_STYLE[activeTask.status]}`}>
            ▶ {TASK_LABELS[activeTask.type]}
          </span>
        ) : (
          <span className="text-[9px] font-mono text-[#252525] uppercase tracking-wider">IDLE</span>
        )}
      </div>

      {/* 액션 버튼 */}
      <div className="flex flex-wrap gap-1 border-t border-[#111] pt-2">
        {type === "tb3" && (
          <>
            <QuickBtn onClick={() => onDispatch("explore")}   color="blue">탐사</QuickBtn>
            <QuickBtn onClick={() => onDispatch("deliver")}   color="gold">수송</QuickBtn>
            <QuickBtn onClick={() => onDispatch("stop")}      color="red" >정지</QuickBtn>
            <QuickBtn onClick={() => onDispatch("diagnose")}  color="gray">진단</QuickBtn>
            <QuickBtn onClick={() => onDispatch("emergency_stop")} color="red">E-STOP</QuickBtn>
          </>
        )}
        {type === "carrier" && (
          <>
            <QuickBtn onClick={() => onDispatch("carrier_task", "station_A")} color="gold">A 배송</QuickBtn>
            <QuickBtn onClick={() => onDispatch("carrier_task", "station_B")} color="gold">B 배송</QuickBtn>
            <QuickBtn onClick={() => onDispatch("emergency_stop")} color="red">E-STOP</QuickBtn>
          </>
        )}
        {type === "arm" && (
          <QuickBtn onClick={() => onDispatch("emergency_stop")} color="red">E-STOP</QuickBtn>
        )}
      </div>
    </div>
  );
}

function QuickBtn({
  onClick, color, children,
}: { onClick: () => void; color: "blue" | "gold" | "red" | "gray"; children: React.ReactNode }) {
  const cls =
    color === "blue" ? "border-blue-900/50 text-blue-400 hover:bg-blue-950/30" :
    color === "gold" ? "border-amber-900/50 text-amber-400 hover:bg-amber-950/30" :
    color === "red"  ? "border-red-900/50 text-red-400 hover:bg-red-950/30" :
                       "border-[#222] text-[#555] hover:bg-[#111] hover:text-[#888]";
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 border text-[9px] font-bold uppercase tracking-wider font-mono transition-all ${cls}`}
    >
      {children}
    </button>
  );
}

// ── 태스크 행 ─────────────────────────────────────────────────────────────────

function TaskRow({ task, onCancel }: { task: FmsTask; onCancel: () => void }) {
  const canCancel = task.status === "active" || task.status === "queued";
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#111] hover:bg-[#0d0d0d] text-[10px] font-mono">
      <div className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[task.status] ?? "bg-[#333]"}`} />
      <span className="w-16 text-[#888] truncate uppercase tracking-wider">
        {task.robotId.replace("vicpinky", "VP").replace("tb3_0", "TB")}
      </span>
      <span className="flex-1 text-[#666] uppercase tracking-wider truncate">
        {TASK_LABELS[task.type]}
        {task.targetId && <span className="text-[#444] ml-1">→{task.targetId}</span>}
      </span>
      <span className={`px-1.5 py-px border text-[9px] font-bold uppercase ${STATUS_STYLE[task.status]}`}>
        {task.status}
      </span>
      <span className="w-14 text-right text-[#333]">{timeAgo(task.createdAt)}</span>
      {canCancel ? (
        <button
          onClick={onCancel}
          className="w-5 h-5 flex items-center justify-center text-[#444] hover:text-red-500 transition-colors"
          title="취소"
        >✕</button>
      ) : (
        <div className="w-5" />
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

type FilterTab = "all" | "active" | "queued" | "completed" | "failed";

type ContentTab = "fleet" | "map";

export default function FmsView({ rosMessages, fmsTasks, socket, emitFmsDispatch, emitFmsCancel, emitNavGoal, emitNavInitialPose }: Props) {
  const [filterTab,   setFilterTab]   = useState<FilterTab>("all");
  const [contentTab,  setContentTab]  = useState<ContentTab>("map");
  const [form, setForm] = useState<{ robotId: string; type: TaskType; targetId: string; notes: string }>({
    robotId: "tb3_01",
    type: "explore",
    targetId: "",
    notes: "",
  });

  // 통계
  const onlineCount  = ROBOTS.filter((r) => isOnline(rosMessages, r.id)).length;
  const activeCount  = fmsTasks.filter((t) => t.status === "active" || t.status === "queued").length;
  const alertCount   = Object.values(rosMessages).filter((m) => {
    const d = m.data as { data?: boolean } | undefined;
    return d?.data === true && m.topic.includes("person_detected");
  }).length;

  // 필터된 태스크
  const filtered = useMemo(() => {
    if (filterTab === "all") return fmsTasks;
    if (filterTab === "active") return fmsTasks.filter((t) => t.status === "active" || t.status === "queued");
    return fmsTasks.filter((t) => t.status === filterTab);
  }, [fmsTasks, filterTab]);

  const dispatch = (robotId: string, type: TaskType, targetId?: string) => {
    emitFmsDispatch({ robotId, type, targetId });
  };

  const handleFormDispatch = () => {
    if (!form.robotId || !form.type) return;
    emitFmsDispatch({
      robotId:  form.robotId,
      type:     form.type,
      targetId: form.targetId || undefined,
      notes:    form.notes    || undefined,
    });
    setForm((f) => ({ ...f, targetId: "", notes: "" }));
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: "all",       label: "전체"   },
    { key: "active",    label: "진행중" },
    { key: "queued",    label: "대기"   },
    { key: "completed", label: "완료"   },
    { key: "failed",    label: "실패"   },
  ];

  const taskTypes: { value: TaskType; label: string; bots: string[] }[] = [
    { value: "explore",       label: "탐사",       bots: ["tb3_01","tb3_02","tb3_03","tb3_04"] },
    { value: "deliver",       label: "수송",       bots: ["tb3_01","tb3_02","tb3_03","tb3_04"] },
    { value: "stop",          label: "정지",       bots: ["tb3_01","tb3_02","tb3_03","tb3_04"] },
    { value: "diagnose",      label: "진단",       bots: ["tb3_01","tb3_02","tb3_03","tb3_04"] },
    { value: "carrier_task",  label: "배송 태스크", bots: ["vicpinky"] },
    { value: "emergency_stop","label": "긴급정지",  bots: ["vicpinky","tb3_01","tb3_02","tb3_03","tb3_04","omx"] },
  ];

  const availableTypes = taskTypes.filter((t) => t.bots.includes(form.robotId));

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── 상단 통계 바 ────────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-6 px-5 py-2.5 bg-[#080808] border-b border-red-900/30">
        <span className="text-[10px] font-black uppercase tracking-[0.3em] text-red-900/60 font-mono">
          FLEET STATUS
        </span>
        <Stat label="온라인" value={`${onlineCount} / ${ROBOTS.length}`}
          color={onlineCount === ROBOTS.length ? "text-green-500" : onlineCount > 0 ? "text-amber-400" : "text-[#444]"} />
        <Stat label="활성 태스크" value={String(activeCount)}
          color={activeCount > 0 ? "text-blue-400" : "text-[#444]"} />
        <Stat label="인원 감지" value={String(alertCount)}
          color={alertCount > 0 ? "text-red-500 danger-pulse" : "text-[#444]"} />
        <div className="flex-1" />
        <span className="text-[9px] font-mono text-[#2a2a2a] uppercase tracking-widest">
          FLEET MANAGEMENT SYSTEM
        </span>
      </div>

      {/* ── 본문 ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── 좌측: 탭 컨텐츠 ───────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 탭 헤더 */}
          <div className="flex-none flex border-b border-[#111] bg-[#080808]">
            {([
              { key: "map"   as ContentTab, label: "◈ 네비게이션 맵" },
              { key: "fleet" as ContentTab, label: "⬡ 로봇 플릿"    },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setContentTab(key)}
                className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wider font-mono border-r border-[#111] transition-all ${
                  contentTab === key
                    ? "text-blue-400 bg-blue-950/20 border-b-2 border-b-blue-600"
                    : "text-[#333] hover:text-[#666]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 맵 탭 */}
          {contentTab === "map" && (
            <div className="flex-1 overflow-hidden">
              <NavMapCanvas
                rosMessages={rosMessages}
                socket={socket}
                onSendGoal={emitNavGoal}
                onSetInitialPose={emitNavInitialPose}
              />
            </div>
          )}

          {/* 플릿 탭 */}
          {contentTab === "fleet" && (
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-[9px] font-bold text-[#333] uppercase tracking-[0.3em] mb-3 font-mono">
                ── ROBOT FLEET ──────────────────────────────────
              </p>
              <div className="grid grid-cols-3 gap-3 xl:grid-cols-3 2xl:grid-cols-6">
                {ROBOTS.map((robot) => (
                  <RobotCard
                    key={robot.id}
                    robot={robot}
                    rosMessages={rosMessages}
                    fmsTasks={fmsTasks}
                    onDispatch={(type, targetId) => dispatch(robot.id, type, targetId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── 우측: Task Panel ───────────────────────────────────────────── */}
        <div className="w-80 flex-none flex flex-col border-l border-red-900/20 bg-[#070707]">

          {/* 탭 필터 */}
          <div className="flex-none flex border-b border-[#111]">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilterTab(tab.key)}
                className={`flex-1 py-2 text-[9px] font-bold uppercase tracking-wider font-mono transition-all ${
                  filterTab === tab.key
                    ? "text-red-400 border-b border-red-600 bg-red-950/20"
                    : "text-[#333] hover:text-[#666]"
                }`}
              >
                {tab.label}
                {tab.key === "active" && activeCount > 0 && (
                  <span className="ml-1 text-blue-400">{activeCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* 태스크 목록 */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-[10px] text-[#2a2a2a] font-mono uppercase tracking-widest">
                태스크 없음
              </div>
            ) : (
              filtered.map((task) => (
                <TaskRow
                  key={task._id}
                  task={task}
                  onCancel={() => emitFmsCancel(task._id)}
                />
              ))
            )}
          </div>

          {/* 태스크 생성 폼 */}
          <div className="flex-none border-t border-[#111] p-3 flex flex-col gap-2.5">
            <p className="text-[9px] font-bold text-[#333] uppercase tracking-[0.25em] font-mono">
              NEW TASK
            </p>

            {/* 로봇 선택 */}
            <select
              value={form.robotId}
              onChange={(e) => {
                const robotId = e.target.value;
                const firstType = taskTypes.find((t) => t.bots.includes(robotId))?.value ?? "stop";
                setForm((f) => ({ ...f, robotId, type: firstType }));
              }}
              className="w-full bg-[#0a0a0a] border border-[#1a1a1a] text-[#888] text-[10px] font-mono
                         px-2 py-1.5 uppercase tracking-wider focus:outline-none focus:border-red-900/60"
            >
              {ROBOTS.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>

            {/* 타입 선택 */}
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as TaskType }))}
              className="w-full bg-[#0a0a0a] border border-[#1a1a1a] text-[#888] text-[10px] font-mono
                         px-2 py-1.5 uppercase tracking-wider focus:outline-none focus:border-red-900/60"
            >
              {availableTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>

            {/* 타겟 (carrier_task일 때) */}
            {form.type === "carrier_task" && (
              <input
                type="text"
                placeholder="Target ID (e.g. station_A)"
                value={form.targetId}
                onChange={(e) => setForm((f) => ({ ...f, targetId: e.target.value }))}
                className="w-full bg-[#0a0a0a] border border-[#1a1a1a] text-[#888] text-[10px] font-mono
                           px-2 py-1.5 placeholder-[#2a2a2a] focus:outline-none focus:border-red-900/60"
              />
            )}

            {/* 디스패치 버튼 */}
            <button
              onClick={handleFormDispatch}
              className="w-full py-2 border border-red-900/50 bg-red-950/20 text-red-400
                         text-[10px] font-black uppercase tracking-[0.2em] font-mono
                         hover:bg-red-950/40 transition-all"
            >
              ▶ DISPATCH
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── 통계 뱃지 ─────────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-[#2a2a2a] font-mono uppercase tracking-widest">{label}</span>
      <span className={`text-[13px] font-black font-mono tabular-nums ${color}`}>{value}</span>
    </div>
  );
}
