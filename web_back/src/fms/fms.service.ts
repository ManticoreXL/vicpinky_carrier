import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import { Task, TaskDocument, TaskStatus, TaskType } from './task.schema';
import { RosService } from '../ros/ros.service';

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
  ) {}

  // ── TaskManager용: 우선순위 큐에 등록 ────────────────────────────────────
  async createQueued(dto: CreateTaskDto): Promise<TaskDocument> {
    const task = await this.taskModel.create({
      task_id:          dto.task_id ?? genTaskId(),
      type:             dto.type,
      targetNode:       dto.targetNode,
      priority:         dto.priority ?? 5,
      status:           TaskStatus.PENDING,
      preferredRobotId: dto.preferredRobotId ?? null,
    });
    const robotLabel = dto.preferredRobotId ? ` → ${dto.preferredRobotId}` : '';
    this.logger.log(`태스크 등록: ${task.task_id} [${dto.type}→${dto.targetNode}] P${dto.priority ?? 5}${robotLabel}`);
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
          status:    TaskStatus.ASSIGNED,
          startedAt,
          pathQueue,
          assignedRobot: { robot_id: robotId, is_completed: false },
        },
        $unset: { waitReason: '' },
      },
    );
    server.emit('fms_task_updated', {
      _id: taskId,
      status: TaskStatus.ASSIGNED,
      startedAt,
      pathQueue,
      assignedRobot: { robot_id: robotId, is_completed: false },
      waitReason: null,
    });
  }

  // ── TaskManager용: RUNNING 전환 ───────────────────────────────────────────
  async setRunning(taskId: string, server: Server): Promise<void> {
    await this.setStatus(taskId, TaskStatus.RUNNING, server);
  }

  // ── TaskManager용: pathQueue 갱신 (waypoint 이동 후) ─────────────────────
  async updatePathQueue(taskId: string, remaining: string[], server: Server): Promise<void> {
    await this.taskModel.updateOne({ _id: taskId }, { pathQueue: remaining });
    server.emit('fms_task_updated', { _id: taskId, pathQueue: remaining });
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
  publishStop(robotId: string): void {
    this.rosService.publish({
      topicName:   `/${robotId}/cmd_vel`,
      messageType: 'geometry_msgs/Twist',
      message: {
        linear:  { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      },
    });
  }

  // ── ROS 발행: 초기 위치 전송 ──────────────────────────────────────────────
  publishInitialPose(robotId: string, x: number, y: number, yaw: number): void {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName:   `/${robotId}/initialpose`,
      messageType: 'geometry_msgs/msg/PoseWithCovarianceStamped',
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
    if (opts.robot_id) filter['assignedRobot.robot_id'] = opts.robot_id;
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
