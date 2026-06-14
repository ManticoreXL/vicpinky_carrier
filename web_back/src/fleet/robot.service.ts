import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Robot, RobotDocument, RobotStatus } from './robot.schema';

@Injectable()
export class RobotService {
  constructor(
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
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
}
