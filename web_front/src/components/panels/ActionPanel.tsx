/**
 * ActionPanel
 * ───────────
 * 모든 로봇에 재사용 가능한 ROS2 Action 전송/상태 표시 컴포넌트.
 *
 * 지원하는 Action 종류:
 * - CarrierTask (커스텀): task_type / target_id / timeout_sec
 * - NavigateToPose (Nav2): x / y / yaw
 */

import { useState } from "react";
import { Section, GoldButton, DangerButton } from "./shared";
import type {
 ActionGoalPayload,
 ActionFeedback,
 ActionResult,
 ActiveGoals,
} from "../../hooks/useNestSocket";

// ── Action 정의 ────────────────────────────────────────────────────────────

export type ActionKind = "carrier_task" | "navigate_to_pose" | "simple_move";

interface ActionDef {
 label: string;
 actionType: string;
 fields: FieldDef[];
 buildGoal: (vals: Record<string, string>) => Record<string, unknown>;
}

interface FieldDef {
 key: string;
 label: string;
 placeholder: string;
 type?: "text" | "number";
}

const ACTION_DEFS: Record<ActionKind, ActionDef> = {
 carrier_task: {
 label: "CarrierTask",
 actionType: "carrier_msgs/action/CarrierTask",
 fields: [
 { key: "task_type", label: "작업 유형", placeholder: "deliver / return / dock / custom" },
 { key: "target_id", label: "목적지 ID", placeholder: "station_A" },
 { key: "timeout_sec", label: "타임아웃 (초)", placeholder: "30", type: "number" },
 ],
 buildGoal: (v) => ({
 task_type: v.task_type ?? "deliver",
 target_id: v.target_id ?? "",
 timeout_sec: parseFloat(v.timeout_sec ?? "0") || 0,
 extra_args: [],
 }),
 },
 simple_move: {
 label: "단순 이동 (Nav2)",
 actionType: "nav2_msgs/action/NavigateToPose",
 fields: [
 { key: "x", label: "X 좌표", placeholder: "1.0", type: "number" },
 { key: "y", label: "Y 좌표", placeholder: "2.0", type: "number" },
 { key: "yaw", label: "회전(Yaw)", placeholder: "0.0", type: "number" },
 ],
 buildGoal: (v) => {
 const yaw = parseFloat(v.yaw ?? "0") || 0;
 return {
 pose: {
 header: { frame_id: "map" },
 pose: {
 position: { x: parseFloat(v.x ?? "0") || 0, y: parseFloat(v.y ?? "0") || 0, z: 0.0 },
 orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
 },
 },
 behavior_tree: "",
 };
 },
 },
 navigate_to_pose: {
 label: "NavigateToPose (Nav2)",
 actionType: "nav2_msgs/action/NavigateToPose",
 fields: [
 { key: "x", label: "X (m)", placeholder: "1.0", type: "number" },
 { key: "y", label: "Y (m)", placeholder: "2.0", type: "number" },
 { key: "yaw", label: "Yaw (rad)", placeholder: "0.0", type: "number" },
 ],
 buildGoal: (v) => {
 const yaw = parseFloat(v.yaw ?? "0") || 0;
 return {
 pose: {
 header: { frame_id: "map" },
 pose: {
 position: { x: parseFloat(v.x ?? "0") || 0, y: parseFloat(v.y ?? "0") || 0, z: 0.0 },
 orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
 },
 },
 behavior_tree: "",
 };
 },
 },
};

// ── 상태 표시 헬퍼 ──────────────────────────────────────────────────────────

// ROS2 action_msgs/GoalStatus — 4=succeeded 5=canceled 6=aborted (3=canceling)
const STATUS_LABELS: Record<number, { label: string; color: string }> = {
 4: { label: "SUCCESS", color: "text-green-600" },
 5: { label: "CANCELLED", color: "text-white/[0.75]" },
 6: { label: "ABORTED", color: "text-white/90" },
};

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
 robotNamespace: string; // e.g. "vicpinky" or "tb3_01"
 emitAction: (payload: ActionGoalPayload) => void;
 cancelAction: (actionName: string, goalId: string) => void;
 activeGoals: ActiveGoals;
 actionFeedbacks: Record<string, ActionFeedback>;
 actionResults: Record<string, ActionResult>;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ActionPanel({
 robotNamespace,
 emitAction,
 cancelAction,
 activeGoals,
 actionFeedbacks,
 actionResults,
}: Props) {
 const [selectedKind, setSelectedKind] = useState<ActionKind>("carrier_task");
 const [fields, setFields] = useState<Record<string, string>>({});

 const def = ACTION_DEFS[selectedKind];
 const actionName = `/${robotNamespace}/${selectedKind}`;

 const activeGoalId = activeGoals[actionName];
 const isRunning = Boolean(activeGoalId);
 const feedback = activeGoalId ? actionFeedbacks[activeGoalId] : undefined;
 const latestResult = activeGoalId
 ? actionResults[activeGoalId]
 : // 완료 후에도 마지막 goalId로 결과 찾기
 Object.values(actionResults).findLast?.(
 (r) => r.actionName === actionName
 );

 function sendGoal() {
 const goal = def.buildGoal(fields);
 emitAction({ actionName, actionType: def.actionType, goal });
 }

 function handleCancel() {
 if (activeGoalId) cancelAction(actionName, activeGoalId);
 }

 const fb = feedback?.feedback as Record<string, unknown> | undefined;
 const progress = typeof fb?.progress === "number" ? fb.progress : null;
 const statusText = typeof fb?.status === "string" ? fb.status : null;
 const distRemaining = typeof fb?.distance_remaining === "number" ? fb.distance_remaining : null;

 const res = latestResult?.result as Record<string, unknown> | undefined;
 const statusInfo = latestResult ? STATUS_LABELS[latestResult.status] ?? { label: "알 수 없음", color: "text-gray-400" } : null;

 return (
 <Section label="Action">
 {/* Action 종류 선택 */}
 <div className="flex gap-1 mb-3">
 {(Object.keys(ACTION_DEFS) as ActionKind[]).map((kind) => (
 <button
 key={kind}
 onClick={() => { setSelectedKind(kind); setFields({}); }}
 className={`px-3 py-1 text-xs font-bold tracking-wide transition-all border ${
 selectedKind === kind
 ? "border-white/[0.1] bg-red-950/30 text-white/90"
 : "border-white/[0.1] bg-transparent text-white/[0.55] hover:text-white/[0.75]"
 }`}
 >
 {ACTION_DEFS[kind].label}
 </button>
 ))}
 </div>

 {/* Goal 필드 */}
 <div className="flex flex-col gap-1.5 mb-3">
 {def.fields.map((f) => (
 <div key={f.key} className="flex items-center gap-2">
 <span className="text-xs text-white/[0.6] tracking-wider w-20 shrink-0">{f.label}</span>
 <input
 type={f.type ?? "text"}
 placeholder={f.placeholder}
 value={fields[f.key] ?? ""}
 onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
 className="flex-1 bg-[#FFCE99]/32 border border-white/[0.1] px-3 py-1.5 text-xs
 text-white/90 placeholder-[#2a2a2a]
 focus:outline-none focus:border-white/[0.1] disabled:opacity-30"
 disabled={isRunning}
 />
 </div>
 ))}
 </div>

 {/* 전송 / 취소 버튼 */}
 <div className="flex gap-2 mb-3">
 <GoldButton onClick={sendGoal}>
 {isRunning ? "RESEND" : "SEND GOAL"}
 </GoldButton>
 {isRunning && (
 <DangerButton onClick={handleCancel}>CANCEL</DangerButton>
 )}
 </div>

 {/* Feedback */}
 {isRunning && (
 <div className="bg-[#FFCE99]/32 border border-white/[0.1] p-3 flex flex-col gap-2">
 <p className="text-xs font-bold text-red-900/60 tracking-[0.25em] ">◆ FEEDBACK</p>
 {statusText && (
 <p className="text-xs text-white/[0.75] ">{statusText}</p>
 )}
 {progress !== null && (
 <div>
 <div className="flex justify-between text-xs text-white/[0.6] mb-1">
 <span>PROGRESS</span>
 <span>{Math.round(progress * 100)}%</span>
 </div>
 <div className="h-1 bg-[#FFCE99]/32 overflow-hidden border border-white/[0.1]">
 <div
 className="h-full bg-red-700 transition-all duration-300"
 style={{ width: `${Math.round(progress * 100)}%` }}
 />
 </div>
 </div>
 )}
 {distRemaining !== null && distRemaining >= 0 && (
 <p className="text-xs text-white/[0.6] ">
 DIST: <span className="text-white/90">{distRemaining.toFixed(2)} m</span>
 </p>
 )}
 </div>
 )}

 {/* Result */}
 {latestResult && !isRunning && statusInfo && (
 <div className="bg-[#FFCE99]/32 border border-white/[0.1] p-3 flex flex-col gap-1">
 <p className="text-xs font-bold text-white/[0.6] tracking-[0.25em] ">◆ RESULT</p>
 <p className={`text-xs font-semibold tracking-wide ${statusInfo.color}`}>
 {statusInfo.label}
 </p>
 {typeof res?.message === "string" && (
 <p className="text-xs text-white/[0.75] ">{res.message}</p>
 )}
 {typeof res?.elapsed_sec === "number" && (
 <p className="text-xs text-white/[0.55] ">
 ELAPSED: {(res.elapsed_sec as number).toFixed(1)}s
 </p>
 )}
 </div>
 )}
 </Section>
 );
}
