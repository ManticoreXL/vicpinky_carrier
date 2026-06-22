import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Task, TaskDocument, TaskStatus } from '../fms/task.schema';
import { Robot, RobotDocument } from '../robot/robot.schema';
import { Node, NodeDocument } from '../topology/node.schema';
import { Log, LogDocument } from '../logs/log.schema';

// 상태 → 한국어 (LLM이 자연스러운 한국어로 답하도록 컨텍스트부터 한글화)
const ROBOT_STATUS_KO: Record<string, string> = {
  IDLE: '대기', MOVING: '이동중', WORKING: '작업중',
  CHARGING: '충전중', ERROR: '오류', OFFLINE: '오프라인',
};
const TASK_STATUS_KO: Record<string, string> = {
  PENDING: '대기중', ASSIGNED: '배정됨', RUNNING: '진행중',
  COMPLETED: '완료', FAILED: '실패', SUSPENDED: '일시정지',
};

function nearestNodeId(x: number, y: number, nodes: NodeDocument[]): string | null {
  if (!nodes.length) return null;
  let best = nodes[0];
  let bestDist = Math.hypot(best.x - x, best.y - y);
  for (let i = 1; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - x, nodes[i].y - y);
    if (d < bestDist) { bestDist = d; best = nodes[i]; }
  }
  return best.node_id;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    @InjectModel(Task.name)  private readonly taskModel:  Model<TaskDocument>,
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(Node.name)  private readonly nodeModel:  Model<NodeDocument>,
    @InjectModel(Log.name)   private readonly logModel:   Model<LogDocument>,
  ) {}

  /**
   * MongoDB 전체 현황을 조회해 LLM 시스템 프롬프트에 삽입할 컨텍스트 문자열 반환
   */
  async buildContext(): Promise<string> {
    try {
      const [robots, activeTasks, recentDone, nodes, recentLogs] = await Promise.all([
        this.robotModel.find().lean().exec(),
        this.taskModel
          .find({ status: { $in: [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.RUNNING, TaskStatus.SUSPENDED] } })
          .sort({ priority: 1, createdAt: 1 })
          .limit(20)
          .lean()
          .exec(),
        this.taskModel
          .find({ status: { $in: [TaskStatus.COMPLETED, TaskStatus.FAILED] } })
          .sort({ updatedAt: -1 })
          .limit(10)
          .lean()
          .exec(),
        this.nodeModel.find().lean().exec(),
        this.logModel
          // 카메라 경고는 AI 컨텍스트에서 제외 — 수시로 끊기는 비핵심 지표라
          // RAG에 섞이면 AI가 카메라 문제를 과대 보고함 (기존 누적 로그까지 차단)
          .find({ level: { $in: ['warn', 'error'] }, category: { $ne: 'camera' } })
          .sort({ createdAt: -1 })
          .limit(8)
          .lean()
          .exec(),
      ]);

      const lines: string[] = ['=== 현재 FMS 데이터베이스 현황 ==='];

      // ── 로봇 ──────────────────────────────────────────────────────────────
      // 포맷 주의: IP는 robot_id 바로 뒤(괄호)에 붙여 노드 ID와 멀리 떨어뜨린다.
      //   (예전 포맷은 "근접노드=station1 (IP: x)" 처럼 IP가 노드 뒤에 와서
      //    LLM이 IP를 노드 속성으로 오해해 답변이 엉망이 됐다.)
      lines.push('\n[로봇 현황]');
      if (robots.length === 0) {
        lines.push('  (등록된 로봇 없음)');
      } else {
        for (const r of robots) {
          const statusKo = ROBOT_STATUS_KO[r.status] ?? r.status;
          const bat  = (r as any).battery != null ? `배터리 ${Math.round((r as any).battery)}%` : '배터리 미상';
          const px = (r as any).pose_x;
          const py = (r as any).pose_y;

          // 위치 서술 — 오프라인/무효좌표(0,0 또는 null)면 근접노드를 추정하지 않는다.
          const isOffline   = String(r.status).toUpperCase() === 'OFFLINE';
          const hasValidPos = px != null && py != null && (Math.abs(px) > 0.05 || Math.abs(py) > 0.05);
          let posDesc: string;
          if (isOffline) {
            posDesc = '위치 미상(오프라인)';
          } else if (hasValidPos) {
            const nid = nearestNodeId(px, py, nodes);
            posDesc = nid
              ? `근접노드 "${nid}" (좌표 ${px.toFixed(2)}, ${py.toFixed(2)})`
              : `좌표 (${px.toFixed(2)}, ${py.toFixed(2)})`;
          } else {
            posDesc = '위치 미확정(AMCL/odom 미수신)';
          }

          const locField = r.location ? ` / 등록노드 ${r.location}` : '';
          lines.push(`  - ${r.robot_id} (IP ${r.ip}): 상태=${statusKo} / ${bat} / ${posDesc}${locField}`);
        }
      }

      // ── 활성 태스크 ────────────────────────────────────────────────────────
      lines.push('\n[진행 중 태스크]');
      if (activeTasks.length === 0) {
        lines.push('  (없음)');
      } else {
        for (const t of activeTasks) {
          const robot = (t as any).assignedRobotId ?? '미배정';
          const wait = t.waitReason ? ` [대기: ${t.waitReason}]` : '';
          const st = TASK_STATUS_KO[t.status] ?? t.status;
          lines.push(`  - [${st}] ${t.type} → ${t.targetNode} / 로봇: ${robot} / P${t.priority}${wait}`);
        }
      }

      // ── 최근 완료/실패 태스크 ─────────────────────────────────────────────
      lines.push('\n[최근 완료/실패 태스크 (최대 10건)]');
      if (recentDone.length === 0) {
        lines.push('  (없음)');
      } else {
        for (const t of recentDone) {
          const robot = (t as any).assignedRobotId ?? '-';
          const ts = t.completedAt ? new Date(t.completedAt as Date).toLocaleTimeString('ko-KR') : '-';
          const st = TASK_STATUS_KO[t.status] ?? t.status;
          lines.push(`  - [${st}] ${t.type} → ${t.targetNode} / 로봇: ${robot} / 완료: ${ts}`);
        }
      }

      // ── 노드 목록 ──────────────────────────────────────────────────────────
      const nodesByType: Record<string, string[]> = {};
      for (const n of nodes) {
        nodesByType[n.type] = nodesByType[n.type] ?? [];
        nodesByType[n.type].push(n.node_id);
      }
      lines.push('\n[토폴로지 노드]');
      for (const [type, ids] of Object.entries(nodesByType)) {
        lines.push(`  ${type}: ${ids.join(', ')}`);
      }

      // ── 최근 경고/오류 로그 ────────────────────────────────────────────────
      lines.push('\n[최근 경고/오류 로그]');
      if (recentLogs.length === 0) {
        lines.push('  (없음)');
      } else {
        for (const l of recentLogs) {
          const bot = l.botId ? `[${l.botId}] ` : '';
          lines.push(`  - [${l.level.toUpperCase()}] ${bot}${l.message}`);
        }
      }

      lines.push('\n=== 컨텍스트 끝 ===');
      return lines.join('\n');
    } catch (err: any) {
      this.logger.error(`RAG context 빌드 실패: ${err.message}`);
      return '(DB 조회 실패 — 컨텍스트 없음)';
    }
  }
}
