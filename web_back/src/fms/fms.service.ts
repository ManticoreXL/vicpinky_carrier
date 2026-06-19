import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import { Task, TaskDocument, TaskStatus, TaskType } from './task.schema';
import { RosService } from '../ros/ros.service';
import { DomainBridgeService } from '../ros/domain-bridge.service';

export interface CreateTaskDto {
  task_id?: string;
  type: TaskType;
  targetNode: string;
  priority?: number;
  preferredRobotId?: string;
}

// task_id 자동 생성 헬퍼
function genTaskId(): string {
  return `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

@Injectable()
export class FmsService {
  private readonly logger = new Logger(FmsService.name);

  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    private readonly rosService: RosService,
    private readonly domainBridgeService: DomainBridgeService,
  ) {}

  // ── cmd_vel 발행 대상 결정 (domain_bridge 참조) ──────────────────────────
  //
  // domain_bridge가 tb3/omx의 cmd_vel을 TwistStamped로 중계하므로,
  // 타입/토픽을 브리지 설정에서 가져와야 정지 명령이 실제로 로봇에 도달한다.
  // 브리지에 없는 로봇(vicpinky 등)은 기존 기본값(/{id}/cmd_vel, Twist)으로 폴백.
  private cmdVelTarget(robotId: string): { topic: string; stamped: boolean } {
    const caps = this.domainBridgeService.getCapabilities(robotId);
    if (caps && !Array.isArray(caps)) {
      const entry = caps.commands.find(
        (c) =>
          c.hubTopic === `/${robotId}/cmd_vel` ||
          c.hubTopic === '/cmd_vel' ||
          c.robotTopic === '/cmd_vel',
      );
      if (entry) return { topic: entry.hubTopic, stamped: /TwistStamped/.test(entry.type) };
    }
    return { topic: `/${robotId}/cmd_vel`, stamped: false };
  }

  // ── TaskManager용: 우선순위 큐에 등록 ────────────────────────────────────
  async createQueued(dto: CreateTaskDto): Promise<TaskDocument> {
    const task = await this.taskModel.create({
      task_id:        dto.task_id ?? genTaskId(),
      type:           dto.type,
      targetNode:     dto.targetNode,
      priority:       dto.priority ?? 5,
      status:         TaskStatus.PENDING,
      preferredRobotId: dto.preferredRobotId ?? null,
    });
    const robotLabel = dto.preferredRobotId ? ` → ${dto.preferredRobotId}` : '';
    this.logger.log(`태스크 등록: ${task.task_id} [${dto.type}→${dto.targetNode}] P${dto.priority ?? 5}${robotLabel}`);
    return task;
  }

  // ── TaskManager용: 등록만(배차 X) — DRAFT 상태로 생성 ─────────────────────
  //
  // createQueued와 달리 status=DRAFT 로 만들어 자동 배차 루프(process)가 건드리지
  // 않게 한다. 관제가 나중에 release()로 PENDING 전환하면 그때 배차된다.
  async createDraft(dto: CreateTaskDto): Promise<TaskDocument> {
    const task = await this.taskModel.create({
      task_id:          dto.task_id ?? genTaskId(),
      type:             dto.type,
      targetNode:       dto.targetNode,
      priority:         dto.priority ?? 5,
      status:           TaskStatus.DRAFT,
      preferredRobotId: dto.preferredRobotId ?? null,
    });
    const robotLabel = dto.preferredRobotId ? ` → ${dto.preferredRobotId}` : '';
    this.logger.log(`태스크 등록(미배차): ${task.task_id} [${dto.type}→${dto.targetNode}] P${dto.priority ?? 5}${robotLabel}`);
    return task;
  }

  // ── TaskManager용: DRAFT → PENDING 배차 큐 투입 ──────────────────────────
  async release(taskId: string, server: Server | null): Promise<TaskDocument | null> {
    const task = await this.taskModel.findById(taskId);
    if (!task || task.status !== TaskStatus.DRAFT) return null;
    await this.setStatus(taskId, TaskStatus.PENDING, server);
    this.logger.log(`태스크 배차: ${task.task_id} [${task.type}→${task.targetNode}] DRAFT → PENDING`);
    return task;
  }

  // ── TaskManager용: 우선순위순 PENDING 태스크 ──────────────────────────────
  async getPendingTasks(limit = 20): Promise<TaskDocument[]> {
    return this.taskModel
      .find({ status: TaskStatus.PENDING })
      .sort({ priority: 1, createdAt: 1 })
      .limit(limit)
      .exec();
  }

  // ── TaskManager용: 진행 중 태스크 (서버 재시작 복구용) ───────────────────
  async getInProgressTasks(): Promise<TaskDocument[]> {
    return this.taskModel
      .find({ status: { $in: [TaskStatus.ASSIGNED, TaskStatus.RUNNING] } })
      .exec();
  }

  // ── TaskManager용: 소켓 없이 상태만 변경 (초기화 단계 복구용) ────────────
  async setStatusDirect(taskId: string, status: TaskStatus): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { status });
  }

  // ── TaskManager용: 단건 조회 ──────────────────────────────────────────────
  async getTask(taskId: string): Promise<TaskDocument | null> {
    return this.taskModel.findById(taskId).exec();
  }

  // ── TaskManager용: 대기 이유 갱신 ─────────────────────────────────────────
  async setWaitReason(taskId: string, reason: string): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { waitReason: reason });
  }

  // ── TaskManager용: 로봇 할당 + 상태 ASSIGNED ─────────────────────────────
  async assignToRobot(
    taskId: string,
    robotId: string,
    pathQueue: string[],
    server: Server,
  ): Promise<void> {
    const startedAt = new Date();
    await this.taskModel.updateOne(
      { _id: taskId },
      {
        $set: {
          status:        TaskStatus.ASSIGNED,
          startedAt,
          pathQueue,
          fullPath:        pathQueue,
          assignedRobotId: robotId,
        },
        $unset: { waitReason: '' },
      },
    );
    server.emit('fms_task_updated', {
      _id: taskId,
      status: TaskStatus.ASSIGNED,
      startedAt,
      pathQueue,
      fullPath:        pathQueue,
      assignedRobotId: robotId,
      waitReason: null,
    });
  }

  // ── TaskManager용: RUNNING 전환 ───────────────────────────────────────────
  async setRunning(taskId: string, server: Server): Promise<void> {
    await this.setStatus(taskId, TaskStatus.RUNNING, server);
  }

  // ── TaskManager용: pathQueue 갱신 (waypoint 이동 후) ─────────────────────
  async updatePathQueue(taskId: string, remaining: string[], server: Server, newFullPath?: string[]): Promise<void> {
    const update: Record<string, unknown> = { pathQueue: remaining };
    if (newFullPath) update.fullPath = newFullPath;
    await this.taskModel.updateOne({ _id: taskId }, update);
    const patch: Record<string, unknown> = { _id: taskId, pathQueue: remaining };
    if (newFullPath) patch.fullPath = newFullPath;
    server.emit('fms_task_updated', patch);
  }

  // ── ROS 발행: 목표 지점 전송 ──────────────────────────────────────────────
  publishGoal(robotId: string, x: number, y: number, yaw: number): void {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName:   `/${robotId}/goal_pose`,
      messageType: 'geometry_msgs/PoseStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          position:    { x, y, z: 0 },
          orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
        },
      },
    });
  }

  // ── ROS 발행: 즉시 정지 (cmd_vel zero) ────────────────────────────────────
  // 토픽/타입은 domain_bridge 설정 기준 (tb3/omx=TwistStamped, vicpinky=Twist)
  publishStop(robotId: string): void {
    const { topic, stamped } = this.cmdVelTarget(robotId);
    const zero = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
    this.rosService.publish({
      topicName:   topic,
      messageType: stamped ? 'geometry_msgs/TwistStamped' : 'geometry_msgs/Twist',
      message: stamped
        ? { header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' }, twist: zero }
        : zero,
    });
  }

  // ── ROS 발행: 초기 위치 전송 ──────────────────────────────────────────────
  publishInitialPose(robotId: string, x: number, y: number, yaw: number): void {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName:   `/${robotId}/initialpose`,
      // rosbridge는 단일 슬래시 형식(pkg/Type)을 사용한다. 다른 토픽(goal_pose,
      // amcl_pose 등)과 동일하게 맞춰야 타입이 정상 해석돼 실제 ROS 발행이 된다.
      // ('geometry_msgs/msg/...' 이중 슬래시면 rosbridge가 타입을 못 풀어 발행 실패)
      messageType: 'geometry_msgs/PoseWithCovarianceStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          pose: {
            position:    { x, y, z: 0 },
            orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
          },
          covariance: [
            0.25, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.25, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.068
          ],
        },
      },
    });
  }

  // ── 상태 변경 (공용) ──────────────────────────────────────────────────────
  async setStatus(
    taskId: string,
    status: TaskStatus,
    server: Server | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { status, ...extra });
    server?.emit('fms_task_updated', { _id: taskId, status, ...extra });
  }

  // ── 취소 ──────────────────────────────────────────────────────────────────
  async cancel(taskId: string, server: Server | null): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return;
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) return;
    await this.setStatus(taskId, TaskStatus.FAILED, server, { completedAt: new Date() });
  }

  // ── 단건 삭제 (DB에서 완전 제거) ─────────────────────────────────────────
  async remove(taskId: string): Promise<void> {
    await this.taskModel.deleteOne({ _id: taskId });
  }

  // ── 목록 조회 ─────────────────────────────────────────────────────────────
  async list(opts: { status?: string; robot_id?: string; limit?: number } = {}) {
    const filter: Record<string, unknown> = {};
    if (opts.status)   filter.status = opts.status;
    if (opts.robot_id) filter['assignedRobotId'] = opts.robot_id;
    return this.taskModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(opts.limit ?? 100, 500))
      .lean()
      .exec();
  }

  async activeCount(): Promise<number> {
    return this.taskModel.countDocuments({
      status: { $in: [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.RUNNING] },
    });
  }
}
