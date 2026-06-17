import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Robot, RobotDocument, RobotStatus } from './robot.schema';
import { Task, TaskDocument } from '../fms/task.schema';

@Injectable()
export class RobotService {
  constructor(
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(Task.name)  private readonly taskModel:  Model<TaskDocument>,
  ) {}

  async create(dto: Partial<Robot>): Promise<RobotDocument> {
    return this.robotModel.create(dto);
  }

  async findAll(): Promise<RobotDocument[]> {
    return this.robotModel.find().lean().exec() as unknown as RobotDocument[];
  }

  async findById(robot_id: string): Promise<RobotDocument | null> {
    return this.robotModel.findOne({ robot_id }).exec();
  }

  async update(robot_id: string, dto: Partial<Robot>): Promise<RobotDocument> {
    const doc = await this.robotModel.findOneAndUpdate({ robot_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Robot ${robot_id} 없음`);
    return doc;
  }

  async remove(robot_id: string): Promise<void> {
    await this.robotModel.deleteOne({ robot_id });
  }

  async updateStatus(robot_id: string, status: RobotStatus): Promise<void> {
    await this.robotModel.updateOne({ robot_id }, { status });
  }

  async updateLocation(robot_id: string, node_id: string | null): Promise<void> {
    await this.robotModel.updateOne({ robot_id }, { location: node_id });
  }

  /**
   * ROS 토픽 텔레메트리(위치/배터리/yaw)를 DB에 즉시 반영.
   * 신규 로봇이면 upsert 등록까지 한 번에 처리한다.
   * (TelemetryService에서 throttle 후 호출 — 여기선 순수 DB write만 담당)
   */
  async updateTelemetry(
    robot_id: string,
    patch: Partial<Pick<Robot, 'pose_x' | 'pose_y' | 'yaw' | 'battery' | 'lastSeenAt'>>,
  ): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id },
      {
        $set: patch,
        $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE },
      },
      { upsert: true },
    );
  }

  /** 온라인 상태(IDLE/MOVING/WORKING)인 로봇 목록 */
  async findOnline(): Promise<RobotDocument[]> {
    return this.robotModel.find({
      status: { $in: [RobotStatus.IDLE, RobotStatus.MOVING, RobotStatus.WORKING] },
    }).exec();
  }

  /**
   * ROS 메시지로 처음 감지된 로봇을 DB에 자동 등록.
   * 이미 존재하면 OFFLINE → IDLE 로 복귀시킨다. (process() 루프에서 반환값 필요)
   */
  async autoRegister(robot_id: string): Promise<RobotDocument> {
    await this.robotModel.updateOne(
      { robot_id },
      { $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE } },
      { upsert: true },
    );
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.OFFLINE },
      { status: RobotStatus.IDLE },
    );
    return this.robotModel.findOne({ robot_id }).exec() as Promise<RobotDocument>;
  }

  /**
   * ROS 토픽 수신 감지 → OFFLINE 이면 IDLE 로 전환, 신규면 등록.
   * MOVING/WORKING 상태는 건드리지 않는다.
   */
  async bringOnlineIfOffline(robot_id: string): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id },
      { $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE } },
      { upsert: true },
    );
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.OFFLINE },
      { status: RobotStatus.IDLE },
    );
  }

  /**
   * ROS 토픽 미수신 → IDLE 상태일 때만 OFFLINE 처리.
   * MOVING/WORKING 중인 로봇은 건드리지 않는다 (태스크 로직이 별도 처리).
   */
  async setOfflineIfIdle(robot_id: string): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.IDLE },
      { status: RobotStatus.OFFLINE },
    );
  }

  /**
   * 강제 종료(크래시) 등 비정상 오프라인 처리.
   * MOVING 포함 모든 상태에서 OFFLINE 으로 전환하고 텔레메트리를 초기화한다.
   * 이때 현재 location이 있으면 lastNode에 백업해둔다.
   */
  async setOffline(robot_id: string): Promise<void> {
    const robot = await this.robotModel.findOne({ robot_id }).exec();
    const lastNode = robot?.location ?? null;

    await this.robotModel.updateOne(
      { robot_id },
      { 
        status: RobotStatus.OFFLINE,
        location: null,
        lastNode: lastNode, // 백업
        battery: null,
        pose_x: null,
        pose_y: null,
        yaw: null
      }
    );
  }

  /** robot_id 변경 — 연관 태스크 cascade 업데이트 */
  async renameRobotId(oldId: string, newId: string): Promise<RobotDocument> {
    const robot = await this.robotModel.findOneAndUpdate(
      { robot_id: oldId },
      { robot_id: newId },
      { new: true },
    );
    if (!robot) throw new NotFoundException(`Robot ${oldId} 없음`);
    await Promise.all([
      this.taskModel.updateMany({ assignedRobotId: oldId },  { assignedRobotId: newId }),
      this.taskModel.updateMany({ preferredRobotId: oldId }, { preferredRobotId: newId }),
    ]);
    return robot;
  }
}
