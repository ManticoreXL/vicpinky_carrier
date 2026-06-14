import { useState, useMemo, useEffect } from "react";
import type { Socket } from "socket.io-client";
import { RosMessage, FmsTask, FmsDispatchPayload, TaskType, TaskStatus, TaskManagerAlert } from "../hooks/useNestSocket";
import NavMapCanvas from "../components/NavMapCanvas";
import { type ActivePath, type RobotPos } from "../components/TopologyMapView";
import { BACKEND_URL } from "../config";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const ROBOTS = [
  { id: "vicpinky", label: "VICPINKY", domain: 40, type: "carrier" },
  { id: "tb3_01",   label: "TB3-01",   domain: 41, type: "tb3"     },
  { id: "tb3_02",   label: "TB3-02",   domain: 42, type: "tb3"     },
  { id: "tb3_03",   label: "TB3-03",   domain: 43, type: "tb3"     },
  { id: "tb3_04",   label: "TB3-04",   domain: 44, type: "tb3"     },
  { id: "omx",      label: "OMX ARM",  domain: 45, type: "arm"     },
] as const;

const TASK_LABELS: Record<TaskType, string> = {
  SUPPLY:     "공급",
  PROCESS:    "처리",
  DISTRIBUTE: "배포",
  CHARGE:     "충전",
  SIMPLE_MOVE: "단순 이동",
};

const STATUS_STYLE: Record<TaskStatus, string> = {
  PENDING:   "text-amber-400  border-amber-900/50  bg-amber-950/20",
  ASSIGNED:  "text-blue-400   border-blue-900/50   bg-blue-950/20",
  RUNNING:   "text-cyan-400   border-cyan-900/50   bg-cyan-950/20",
  COMPLETED: "text-green-500  border-green-900/50  bg-green-950/20",
  FAILED:    "text-red-500    border-red-900/50    bg-red-950/20",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  PENDING:   "bg-amber-400",
  ASSIGNED:  "bg-blue-400 animate-pulse",
  RUNNING:   "bg-cyan-400 animate-pulse",
  COMPLETED: "bg-green-500",
  FAILED:    "bg-red-500",
};

const ONLINE_THRESHOLD_MS = 5000;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  rosMessages:      Record<string, RosMessage>;
  fmsTasks:         FmsTask[];
  tmAlerts:         TaskManagerAlert[];
  socket:           Socket | null;
  emitFmsDispatch:  (p: FmsDispatchPayload) => void;
  emitFmsCancel:    (taskId: string) => void;
  emitNavGoal:      (robotId: string, x: number, y: number, yaw: number) => void;
  emitNavInitialPose: (robotId: string, x: number, y: number, yaw: number) => void;
  ackTmAlert:       (alertId: string) => void;
  setRobotHome:     (robotId: string, x: number, y: number, yaw: number) => void;
  occupiedEdges?:   Record<string, { from: string; to: string; mapId: string }>;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function isOnline(rosMessages: Record<string, RosMessage>, robotId: string): boolean {
  const topics =
    robotId === "vicpinky" ? ["/vicpinky/odom", "/vicpinky/scan"] :
    robotId === "omx"      ? ["/omx/joint_states"] :
    [`/${robotId}/odom`, `/${robotId}/scan`];
  const now = Date.now();
  return topics.some((t) => {
    const msg = rosMessages[t];
    return msg && now - msg.timestamp < ONLINE_THRESHOLD_MS;
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)   return `${Math.floor(diff / 1000)}초 전`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return `${Math.floor(diff / 3600000)}시간 전`;
}

function priorityStyle(p: number): string {
  if (p <= 2) return "text-red-400 border-red-900/60";
  if (p <= 4) return "text-amber-400 border-amber-900/60";
  if (p <= 6) return "text-blue-400/70 border-blue-900/40";
  return "text-[#333] border-[#1a1a1a]";
}

// ── 로봇 카드 ─────────────────────────────────────────────────────────────────

function RobotCard({
  robot, rosMessages, fmsTasks, mapAssignment,
}: {
  robot: typeof ROBOTS[number];
  rosMessages: Record<string, RosMessage>;
  fmsTasks: FmsTask[];
  mapAssignment?: string;
}) {
  const { id, label, domain, type } = robot;
  const online = isOnline(rosMessages, id);
  const p = (topic: string) => rosMessages[`/${id}/${topic}`]?.data;

  const batData  = p("battery_state") as { percentage?: number } | undefined;
  const batPct   = batData?.percentage != null
    ? Math.round(batData.percentage > 1 ? batData.percentage : batData.percentage * 100)
    : null;
  const odomData = p("odom") as { pose?: { pose?: { position?: { x?: number; y?: number } } } } | undefined;
  const pos      = odomData?.pose?.pose?.position;
  const detected = (p("yolo/person_detected") as { data?: boolean } | undefined)?.data ?? false;

  // 이 로봇에 할당된 활성 태스크
  const activeTask = fmsTasks.find(
    (t) => t.assignedRobot?.robot_id === id &&
           (t.status === "ASSIGNED" || t.status === "RUNNING"),
  );

  return (
    <div className={`flex flex-col gap-2.5 p-3 border transition-all ${
      online ? "border-red-900/40 bg-[#0a0a0a]" : "border-[#1a1a1a] bg-[#060606] opacity-60"
    }`}>
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full flex-none ${online ? "bg-green-500 animate-pulse" : "bg-[#333]"}`} />
          <span className="text-[11px] font-black tracking-widest uppercase font-mono text-[#c0c0c0]">{label}</span>
        </div>
        <div className="flex items-center gap-1">
          {mapAssignment && (
            <span className="text-[8px] font-mono text-blue-400/60 border border-blue-900/30 px-1 py-0.5 truncate max-w-[70px]" title={mapAssignment}>
              ◈ {mapAssignment}
            </span>
          )}
          <span className="text-[9px] font-mono text-[#333] border border-[#1a1a1a] px-1.5 py-0.5">D:{domain}</span>
        </div>
      </div>

      {/* 상태 정보 */}
      <div className="flex flex-col gap-1 text-[10px] font-mono min-h-[40px]">
        {type === "tb3" && (
          <>
            {batPct != null && (
              <div className="flex justify-between">
                <span className="text-[#444]">BAT</span>
                <span className={batPct < 20 ? "text-red-500 font-bold" : batPct < 50 ? "text-amber-400" : "text-green-500"}>
                  {batPct}%
                </span>
              </div>
            )}
            {pos && (
              <div className="flex justify-between">
                <span className="text-[#444]">POS</span>
                <span className="text-[#888]">{(pos.x ?? 0).toFixed(1)}, {(pos.y ?? 0).toFixed(1)}</span>
              </div>
            )}
            {detected && <div className="text-red-500 font-black danger-pulse text-center text-[9px]">⚠ PERSON</div>}
          </>
        )}
      </div>

      {/* 현재 태스크 */}
      <div className="h-5 flex items-center border-t border-[#111] pt-2">
        {activeTask ? (
          <div className="flex items-center gap-1.5">
            <span className={`text-[9px] font-mono px-1.5 py-px border font-bold uppercase ${STATUS_STYLE[activeTask.status]}`}>
              {TASK_LABELS[activeTask.type]}
            </span>
            <span className="text-[9px] text-[#555] font-mono truncate max-w-[80px]">→ {activeTask.targetNode}</span>
          </div>
        ) : (
          <span className="text-[9px] font-mono text-[#252525] uppercase tracking-wider">IDLE</span>
        )}
      </div>
    </div>
  );
}

// ── 태스크 행 ─────────────────────────────────────────────────────────────────

function TaskRow({ task, onCancel }: { task: FmsTask; onCancel: () => void }) {
  const canCancel = task.status === "PENDING" || task.status === "ASSIGNED" || task.status === "RUNNING";
  const prio      = task.priority ?? 5;
  const assignedId = task.assignedRobot?.robot_id;
  const robotShort = assignedId
    ? assignedId.replace("vicpinky", "VP").replace("tb3_0", "TB")
    : task.preferredRobotId
    ? `⋯${task.preferredRobotId.replace("tb3_0", "TB")}`
    : "—";
  const pathDone   = task.pathQueue?.length === 0 && task.status === "RUNNING";

  return (
    <div className="flex flex-col border-b border-[#0d0d0d] hover:bg-[#0d0d0d] text-[10px] font-mono">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className={`w-1.5 h-1.5 rounded-full flex-none ${STATUS_DOT[task.status] ?? "bg-[#333]"}`} />
        <span className={`px-1 py-px border text-[8px] font-bold ${priorityStyle(prio)}`}>P{prio}</span>
        <span className="w-12 text-[#666] truncate">{robotShort}</span>
        <span className={`text-[9px] font-bold uppercase tracking-wider ${
          task.type === "SUPPLY" ? "text-blue-400" :
          task.type === "PROCESS" ? "text-amber-400" :
          task.type === "DISTRIBUTE" ? "text-purple-400" :
          task.type === "SIMPLE_MOVE" ? "text-cyan-400" : "text-green-400"
        }`}>{TASK_LABELS[task.type]}</span>
        <span className="flex-1 text-[#555] truncate">→ {task.targetNode}</span>
        <span className={`px-1.5 py-px border text-[9px] font-bold uppercase ${STATUS_STYLE[task.status]}`}>
          {task.status}
        </span>
        {canCancel ? (
          <button onClick={onCancel} className="w-5 h-5 flex items-center justify-center text-[#333] hover:text-red-500 transition-colors">✕</button>
        ) : <div className="w-5" />}
      </div>

      {/* 경로 진행 표시 */}
      {task.status === "RUNNING" && task.pathQueue && task.pathQueue.length > 0 && (
        <p className="px-3 pb-1.5 text-[9px] text-cyan-500/60 font-mono">
          ↗ 다음: {task.pathQueue[0]}{task.pathQueue.length > 1 ? ` (+${task.pathQueue.length - 1})` : ""}
        </p>
      )}
      {pathDone && (
        <p className="px-3 pb-1.5 text-[9px] text-green-500/60 font-mono">✓ 목적지 도착</p>
      )}
      {task.waitReason && (task.status === "PENDING") && (
        <p className="px-3 pb-1.5 text-[9px] text-amber-500/60 font-mono">⏸ {task.waitReason}</p>
      )}
    </div>
  );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

type FilterTab   = "all" | "active" | "PENDING" | "COMPLETED" | "FAILED";
type ContentTab  = "fleet" | "map";

export default function FmsView({
  rosMessages, fmsTasks, tmAlerts, socket,
  emitFmsDispatch, emitFmsCancel,
  emitNavGoal, emitNavInitialPose,
  ackTmAlert, setRobotHome, occupiedEdges = {},
}: Props) {
  const [filterTab,      setFilterTab]      = useState<FilterTab>("all");
  const [contentTab,     setContentTab]     = useState<ContentTab>("map");
  const [mapAssignments, setMapAssignments] = useState<Record<string, string>>({});
  const [multiNodeMode,  setMultiNodeMode]  = useState(false);
  const [form, setForm] = useState<{
    type: TaskType; targetNode: string; priority: number; robotId: string;
  }>({ type: "SUPPLY", targetNode: "", priority: 5, robotId: "" });

  useEffect(() => {
    const base = BACKEND_URL.replace(/\/$/, "");
    fetch(`${base}/api/map/assignments`)
      .then((r) => r.json())
      .then((d: Record<string, string>) => setMapAssignments(d))
      .catch(() => {});
  }, []);

  // 통계
  const onlineCount = ROBOTS.filter((r) => isOnline(rosMessages, r.id)).length;
  const activeCount = fmsTasks.filter(
    (t) => t.status === "PENDING" || t.status === "ASSIGNED" || t.status === "RUNNING",
  ).length;
  const alertCount  = Object.values(rosMessages).filter((m) => {
    const d = m.data as { data?: boolean } | undefined;
    return d?.data === true && m.topic.includes("person_detected");
  }).length;

  const filtered = useMemo(() => {
    if (filterTab === "all")    return fmsTasks;
    if (filterTab === "active") return fmsTasks.filter(
      (t) => t.status === "PENDING" || t.status === "ASSIGNED" || t.status === "RUNNING",
    );
    return fmsTasks.filter((t) => t.status === filterTab);
  }, [fmsTasks, filterTab]);

  // ── 토폴로지 오버레이 데이터 (NavMapCanvas로 전달) ───────────────────────

  const activePaths = useMemo<ActivePath[]>(() => {
    return fmsTasks
      .filter(t =>
        (t.status === "RUNNING" || t.status === "ASSIGNED") &&
        t.assignedRobot?.robot_id &&
        (t.pathQueue?.length ?? 0) > 0,
      )
      .map(t => ({
        robotId:    t.assignedRobot.robot_id!,
        pathQueue:  t.pathQueue ?? [],
        fromNodeId: undefined,
      }));
  }, [fmsTasks]);

  const robotPositions = useMemo<Record<string, RobotPos>>(() => {
    const result: Record<string, RobotPos> = {};
    activePaths.forEach(({ robotId }) => {
      const amcl = rosMessages[`/${robotId}/amcl_pose`]?.data as {
        pose?: { pose?: { position?: { x?: number; y?: number } } }
      } | undefined;
      const pos = amcl?.pose?.pose?.position;
      if (pos?.x != null) { result[robotId] = { x: pos.x, y: pos.y ?? 0 }; return; }

      const odom = rosMessages[`/${robotId}/odom`]?.data as {
        pose?: { pose?: { position?: { x?: number; y?: number } } }
      } | undefined;
      const opos = odom?.pose?.pose?.position;
      if (opos?.x != null) result[robotId] = { x: opos.x, y: opos.y ?? 0 };
    });
    return result;
  }, [activePaths, rosMessages]);

  const handleDispatch = () => {
    if (!form.targetNode.trim()) return;
    emitFmsDispatch({
      type:             form.type,
      targetNode:       form.targetNode.trim(),
      priority:         form.priority,
      preferredRobotId: form.robotId || undefined,
    });
    setForm((f) => ({ ...f, targetNode: "" }));
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: "all",       label: "전체"   },
    { key: "active",    label: "진행중" },
    { key: "PENDING",   label: "대기"   },
    { key: "COMPLETED", label: "완료"   },
    { key: "FAILED",    label: "실패"   },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── 상단 통계 바 ──────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-6 px-5 py-2.5 bg-[#080808] border-b border-red-900/30">
        <span className="text-[10px] font-black uppercase tracking-[0.3em] text-red-900/60 font-mono">FLEET STATUS</span>
        <Stat label="온라인"    value={`${onlineCount} / ${ROBOTS.length}`}
          color={onlineCount === ROBOTS.length ? "text-green-500" : onlineCount > 0 ? "text-amber-400" : "text-[#444]"} />
        <Stat label="활성 태스크" value={String(activeCount)}
          color={activeCount > 0 ? "text-blue-400" : "text-[#444]"} />
        <Stat label="인원 감지"  value={String(alertCount)}
          color={alertCount > 0 ? "text-red-500 danger-pulse" : "text-[#444]"} />
        {tmAlerts.filter((a) => a.requiresAction).length > 0 && (
          <Stat label="조치 필요" value={String(tmAlerts.filter((a) => a.requiresAction).length)}
            color="text-amber-400 danger-pulse" />
        )}
        <div className="flex-1" />
        <span className="text-[9px] font-mono text-[#2a2a2a] uppercase tracking-widest">FLEET MANAGEMENT SYSTEM</span>
      </div>

      {/* ── 본문 ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── 좌측: 탭 컨텐츠 ───────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-none flex border-b border-[#111] bg-[#080808]">
            {([
              { key: "map"   as ContentTab, label: "◈ 맵 / 토폴로지" },
              { key: "fleet" as ContentTab, label: "⬡ 로봇 플릿"     },
            ]).map(({ key, label }) => (
              <button key={key} onClick={() => setContentTab(key)}
                className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wider font-mono border-r border-[#111] transition-all ${
                  contentTab === key ? "text-blue-400 bg-blue-950/20 border-b-2 border-b-blue-600" : "text-[#333] hover:text-[#666]"
                }`}>
                {label}
              </button>
            ))}
          </div>

          {contentTab === "map" && (
            <div className="flex-1 overflow-hidden">
              <NavMapCanvas
                rosMessages={rosMessages}
                socket={socket}
                onSendGoal={emitNavGoal}
                onSetInitialPose={emitNavInitialPose}
                onSetHome={setRobotHome}
                activePaths={activePaths}
                robotPositions={robotPositions}
                occupiedEdges={occupiedEdges}
                onNodeClick={(nodeId) => {
                  setForm(f => ({
                    ...f,
                    targetNode: multiNodeMode ? (f.targetNode ? `${f.targetNode}, ${nodeId}` : nodeId) : nodeId
                  }))
                }}
              />
            </div>
          )}

          {contentTab === "fleet" && (
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-[9px] font-bold text-[#333] uppercase tracking-[0.3em] mb-3 font-mono">── ROBOT FLEET ──────────────────────────────────</p>
              <div className="grid grid-cols-3 gap-3 xl:grid-cols-3 2xl:grid-cols-6">
                {ROBOTS.map((robot) => (
                  <RobotCard
                    key={robot.id}
                    robot={robot}
                    rosMessages={rosMessages}
                    fmsTasks={fmsTasks}
                    mapAssignment={mapAssignments[robot.id]}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── 우측: Task Panel ───────────────────────────────────────────── */}
        <div className="w-80 flex-none flex flex-col border-l border-red-900/20 bg-[#070707]">

          {/* 필터 탭 */}
          <div className="flex-none flex border-b border-[#111]">
            {TABS.map((tab) => (
              <button key={tab.key} onClick={() => setFilterTab(tab.key)}
                className={`flex-1 py-2 text-[9px] font-bold uppercase tracking-wider font-mono transition-all ${
                  filterTab === tab.key
                    ? "text-red-400 border-b border-red-600 bg-red-950/20"
                    : "text-[#333] hover:text-[#666]"
                }`}>
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
              <div className="flex items-center justify-center h-20 text-[10px] text-[#2a2a2a] font-mono uppercase tracking-widest">태스크 없음</div>
            ) : (
              filtered.map((task) => (
                <TaskRow key={task._id} task={task} onCancel={() => emitFmsCancel(task._id)} />
              ))
            )}
          </div>

          {/* 관제탑 알림 */}
          {tmAlerts.length > 0 && (
            <div className="flex-none border-t border-[#111] max-h-44 overflow-y-auto">
              <p className="sticky top-0 bg-[#080808] px-3 py-1 text-[9px] font-bold text-amber-500/70 uppercase tracking-[0.25em] font-mono border-b border-[#111] z-10">
                ⚠ 관제탑 알림 ({tmAlerts.filter((a) => a.requiresAction).length})
              </p>
              {tmAlerts.map((alert) => (
                <div key={alert.id}
                  className={`flex items-start gap-2 px-3 py-2 border-b border-[#0d0d0d] ${alert.requiresAction ? "bg-amber-950/10" : ""}`}>
                  <span className={`mt-0.5 text-[8px] flex-none ${
                    alert.type === "battery"       ? "text-amber-400" :
                    alert.type === "task_failed"   ? "text-red-400"   :
                    alert.type === "robot_offline" ? "text-red-400"   :
                    alert.type === "assigned"      ? "text-blue-400"  :
                    alert.type === "completed"     ? "text-green-500" : "text-[#555]"
                  }`}>
                    {alert.type === "battery" ? "🔋" :
                     alert.type === "task_failed"   ? "✕" :
                     alert.type === "robot_offline" ? "⚠" :
                     alert.type === "assigned"      ? "▶" :
                     alert.type === "completed"     ? "✓" : "ℹ"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono text-[#888] leading-tight">{alert.message}</p>
                    <p className="text-[8px] font-mono text-[#333] mt-0.5">{new Date(alert.timestamp).toLocaleTimeString("ko-KR")}</p>
                  </div>
                  <button onClick={() => ackTmAlert(alert.id)} className="text-[9px] text-[#333] hover:text-[#666] flex-none">✕</button>
                </div>
              ))}
            </div>
          )}

          {/* 태스크 생성 폼 */}
          <div className="flex-none border-t border-[#111] p-3 flex flex-col gap-2.5">
            <p className="text-[9px] font-bold text-[#333] uppercase tracking-[0.25em] font-mono">NEW TASK</p>

            {/* 타입 */}
            <div className="grid grid-cols-5 gap-px">
              {(["SUPPLY","PROCESS","DISTRIBUTE","CHARGE","SIMPLE_MOVE"] as TaskType[]).map((t) => (
                <button key={t} onClick={() => setForm((f) => ({ ...f, type: t }))}
                  className={`py-1 text-[8px] font-mono font-bold uppercase transition-all ${
                    form.type === t
                      ? t === "SUPPLY"     ? "bg-blue-900/40 text-blue-400"   :
                        t === "PROCESS"    ? "bg-amber-900/40 text-amber-400" :
                        t === "DISTRIBUTE" ? "bg-purple-900/40 text-purple-400" :
                        t === "SIMPLE_MOVE" ? "bg-cyan-900/40 text-cyan-400" :
                                             "bg-green-900/40 text-green-400"
                      : "text-[#333] hover:text-[#666]"
                  }`}>
                  {TASK_LABELS[t]}
                </button>
              ))}
            </div>

            {/* 목표 노드 */}
            <input
              type="text"
              placeholder="Target Node ID (예: station_A)"
              value={form.targetNode}
              onChange={(e) => setForm((f) => ({ ...f, targetNode: e.target.value }))}
              className="w-full bg-[#0a0a0a] border border-[#1a1a1a] text-[#888] text-[10px] font-mono px-2 py-1.5 placeholder-[#2a2a2a] focus:outline-none focus:border-red-900/60"
            />

            {/* 로봇 지정 */}
            <select
              value={form.robotId}
              onChange={(e) => setForm((f) => ({ ...f, robotId: e.target.value }))}
              className="w-full bg-[#0a0a0a] border border-[#1a1a1a] text-[#888] text-[10px] font-mono px-2 py-1.5 focus:outline-none focus:border-red-900/60 appearance-none"
            >
              <option value="">── 로봇 자동 배정 ──</option>
              {ROBOTS.filter((r) => r.type !== "arm").map((r) => {
                const online = isOnline(rosMessages, r.id);
                return (
                  <option key={r.id} value={r.id} disabled={!online}>
                    {r.label}{!online ? " (오프라인)" : ""}
                  </option>
                );
              })}
            </select>

            {/* 연속 선택 토글 */}
            <label className="flex items-center gap-2 cursor-pointer group">
              <div className={`w-3 h-3 border flex items-center justify-center transition-colors ${
                multiNodeMode ? "bg-red-900/50 border-red-500" : "bg-[#0a0a0a] border-[#333]"
              }`}>
                {multiNodeMode && <div className="w-1.5 h-1.5 bg-red-400" />}
              </div>
              <span className="text-[9px] font-mono text-[#666] group-hover:text-[#aaa] transition-colors">
                지도에서 노드 클릭 시 연속 추가 (다중 경로)
              </span>
            </label>

            {/* 우선순위 */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-[#444] uppercase tracking-widest w-4">P</span>
              <div className="flex flex-1">
                {([1,3,5,7,10] as const).map((p) => (
                  <button key={p} onClick={() => setForm((f) => ({ ...f, priority: p }))}
                    className={`flex-1 py-0.5 text-[8px] font-mono font-bold border-r border-[#111] last:border-0 transition-all ${
                      form.priority === p
                        ? p <= 2 ? "bg-red-900/40 text-red-400" :
                          p <= 4 ? "bg-amber-900/40 text-amber-400" :
                          p <= 6 ? "bg-blue-900/40 text-blue-400" : "bg-[#111] text-[#555]"
                        : "text-[#333] hover:text-[#666]"
                    }`}>
                    {p <= 2 ? "긴급" : p <= 4 ? "높음" : p <= 6 ? "보통" : p <= 8 ? "낮음" : "최저"}
                  </button>
                ))}
              </div>
            </div>

            {/* 디스패치 */}
            <button onClick={handleDispatch}
              disabled={!form.targetNode.trim()}
              className="w-full py-2 border border-red-900/50 bg-red-950/20 text-red-400 text-[10px] font-black uppercase tracking-[0.2em] font-mono hover:bg-red-950/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
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
