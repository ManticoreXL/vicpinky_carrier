import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Task, TaskDocument, TaskStatus } from '../fms/task.schema';
import { Robot, RobotDocument } from '../fleet/robot.schema';
import { Node, NodeDocument } from '../fleet/node.schema';
import { Log, LogDocument } from '../logs/log.schema';

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
          .find({ level: { $in: ['warn', 'error'] } })
          .sort({ createdAt: -1 })
          .limit(8)
          .lean()
          .exec(),
      ]);

      const lines: string[] = ['=== 현재 FMS 데이터베이스 현황 ==='];

      // ── 로봇 ──────────────────────────────────────────────────────────────
      lines.push('\n[로봇 현황]');
      if (robots.length === 0) {
        lines.push('  (등록된 로봇 없음)');
      } else {
        for (const r of robots) {
          const loc = r.location ? ` @ ${r.location}` : '';
          lines.push(`  - ${r.robot_id}: ${r.status}${loc} (IP: ${r.ip}, Domain: ${r.ros_domain_id})`);
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
          lines.push(`  - [${t.status}] ${t.type} → ${t.targetNode} / 로봇: ${robot} / P${t.priority}${wait}`);
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
          lines.push(`  - [${t.status}] ${t.type} → ${t.targetNode} / 로봇: ${robot} / 완료: ${ts}`);
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
