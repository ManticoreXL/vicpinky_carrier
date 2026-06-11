import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Server } from 'socket.io';
import { Task, TaskDocument, TaskStatus, TaskType } from './task.schema';
import { RosService } from '../ros/ros.service';

export interface CreateTaskDto {
  robotId: string;
  type: TaskType;
  targetId?: string;
  notes?: string;
}

@Injectable()
export class FmsService {
  private readonly logger = new Logger(FmsService.name);

  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    private readonly rosService: RosService,
  ) {}

  // ── 생성 + ROS 디스패치 ─────────────────────────────────────────────────────
  async createAndDispatch(dto: CreateTaskDto, server: Server): Promise<TaskDocument> {
    const task = await this.taskModel.create({ ...dto, status: 'queued' });
    this.logger.log(`태스크 생성: ${task._id} [${dto.robotId}/${dto.type}]`);

    try {
      this.dispatch(task, server);
      await this.setStatus(task._id.toString(), 'active', server, { startedAt: new Date() });
    } catch (e) {
      await this.setStatus(task._id.toString(), 'failed', server);
    }

    return task;
  }

  // ── ROS 디스패치 ────────────────────────────────────────────────────────────
  private dispatch(task: TaskDocument, server: Server) {
    const { robotId, type, targetId } = task;
    const taskId = task._id.toString();

    switch (type) {
      case 'explore':
      case 'deliver':
      case 'stop':
        this.rosService.publish({
          topicName: `/${robotId}/cmd`,
          messageType: 'std_msgs/String',
          message: { data: type },
        });
        // 토픽 발행은 즉시 완료 처리
        void this.setStatus(taskId, 'completed', server, { completedAt: new Date() });
        break;

      case 'emergency_stop':
        this.rosService.publish({
          topicName: `/${robotId}/cmd_vel`,
          messageType: robotId === 'vicpinky' ? 'geometry_msgs/Twist' : 'geometry_msgs/TwistStamped',
          message: robotId === 'vicpinky'
            ? { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }
            : { header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
                twist: { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } } },
        });
        void this.setStatus(taskId, 'completed', server, { completedAt: new Date() });
        break;

      case 'carrier_task':
        this.rosService.sendActionGoal(
          {
            actionName: '/vicpinky/carrier_task',
            actionType: 'carrier_msgs/action/CarrierTask',
            goal: { task_type: 'deliver', target_id: targetId ?? '', timeout_sec: 0, extra_args: [] },
          },
          (fb) => {
            server.emit('fms_task_feedback', { taskId, feedback: fb.feedback });
          },
          async (res) => {
            const status: TaskStatus = res.status === 3 ? 'completed' : 'failed';
            await this.setStatus(taskId, status, server, {
              completedAt: new Date(),
              result: res.result,
            });
          },
        );
        break;

      case 'diagnose':
        this.rosService.callService(
          {
            serviceName: `/${robotId}/run_diagnosis`,
            serviceType: 'turtlebot3_custom_msgs/srv/SelfDiagnosis',
            request: { target_component: 'all' },
          },
          async (res) => {
            const r = res as { is_ok?: boolean; summary_message?: string };
            const status: TaskStatus = r.is_ok ? 'completed' : 'failed';
            await this.setStatus(taskId, status, server, {
              completedAt: new Date(),
              result: res as Record<string, unknown>,
            });
          },
        );
        break;

      default:
        this.logger.warn(`알 수 없는 태스크 타입: ${type}`);
    }
  }

  // ── 상태 변경 ────────────────────────────────────────────────────────────────
  private async setStatus(
    taskId: string,
    status: TaskStatus,
    server: Server,
    extra: Record<string, unknown> = {},
  ) {
    await this.taskModel.updateOne({ _id: taskId }, { status, ...extra });
    server.emit('fms_task_updated', { _id: taskId, status, ...extra });
    this.logger.debug(`태스크 상태 변경: ${taskId} → ${status}`);
  }

  // ── 취소 ────────────────────────────────────────────────────────────────────
  async cancel(taskId: string, server: Server): Promise<void> {
    const task = await this.taskModel.findById(taskId);
    if (!task) return;
    if (task.status === 'completed' || task.status === 'failed') return;
    await this.setStatus(taskId, 'cancelled', server, { completedAt: new Date() });
  }

  // ── 조회 ────────────────────────────────────────────────────────────────────
  async list(opts: { status?: string; robotId?: string; limit?: number } = {}) {
    const filter: Record<string, unknown> = {};
    if (opts.status)  filter.status  = opts.status;
    if (opts.robotId) filter.robotId = opts.robotId;

    return this.taskModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(opts.limit ?? 100, 500))
      .lean()
      .exec();
  }

  // ── 활성 태스크 수 ──────────────────────────────────────────────────────────
  async activeCount(): Promise<number> {
    return this.taskModel.countDocuments({ status: { $in: ['queued', 'active'] } });
  }
}
