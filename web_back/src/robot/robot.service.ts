import { Injectable, NotFoundException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Robot, RobotDocument, RobotStatus } from './robot.schema';
import { TaskHistory, TaskHistoryDocument } from '../fms/task.schema';

@Injectable()
export class RobotService implements OnModuleInit {
  private readonly logger = new Logger(RobotService.name);

  constructor(
    @InjectModel(Robot.name) private readonly robotModel: Model<RobotDocument>,
    @InjectModel(TaskHistory.name)  private readonly taskModel:  Model<TaskHistoryDocument>,
  ) {}

  /**
   * 스키마 의미 변경 마이그레이션(멱등):
   *  - location = 맵 id (예전 map_id 필드 값)
   *  - lastNode = 노드 id (예전 location 필드 값)
   *  - 레거시 map_id 필드 제거
   * map_id 필드가 남아있는 문서만 대상이라 한 번 처리되면 다시 건드리지 않는다.
   */
  async onModuleInit(): Promise<void> {
    const coll = this.robotModel.collection;
    const legacy = await coll.find({ map_id: { $exists: true } }).toArray();
    if (legacy.length === 0) return;
    for (const r of legacy) {
      const set: Record<string, unknown> = {};
      if (r.map_id != null) set.location = r.map_id;                       // map → location
      if (r.lastNode == null && r.location != null && r.location !== r.map_id) {
        set.lastNode = r.location;                                         // 옛 location(노드) → lastNode
      }
      await coll.updateOne(
        { _id: r._id },
        { ...(Object.keys(set).length ? { $set: set } : {}), $unset: { map_id: '' } },
      );
    }
    this.logger.log(`[마이그레이션] location=맵 / lastNode=노드 로 ${legacy.length}건 정리 (map_id 제거)`);
  }

  async create(dto: Partial<Robot>): Promise<RobotDocument> {
    return this.robotModel.create(dto);
  }

  async findAll(): Promise<RobotDocument[]> {
    return this.robotModel.find().sort({ ros_domain_id: 1 }).lean().exec() as unknown as RobotDocument[];
  }

  async findById(robot_id: string): Promise<RobotDocument | null> {
    return this.robotModel.findOne({ robot_id }).exec();
  }

  async update(robot_id: string, dto: Partial<Robot>): Promise<RobotDocument> {
    const doc = await this.robotModel.findOneAndUpdate({ robot_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Robot ${robot_id} 없음`);
    return doc;
  }

  /** 재시작 초기화 — location(맵 id)/pose(lastNode 좌표)를 한 번에 설정(없는 키는 그대로). */
  async setPlacement(
    robot_id: string,
    patch: Partial<Pick<Robot, 'location' | 'pose_x' | 'pose_y' | 'yaw'>>,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.robotModel.updateOne({ robot_id }, { $set: patch });
  }

  async remove(robot_id: string): Promise<void> {
    await this.robotModel.deleteOne({ robot_id });
  }

  async updateStatus(robot_id: string, status: RobotStatus): Promise<void> {
    // online은 status에서 파생(OFFLINE이 아니면 온라인) — 항상 함께 갱신해 단일 진실 유지
    await this.robotModel.updateOne({ robot_id }, { status, online: status !== RobotStatus.OFFLINE });
  }

  /** 로봇이 위치한 노드(lastNode) 갱신 — 주행하며 노드 통과 시 호출 */
  async updateNode(robot_id: string, node_id: string | null): Promise<void> {
    await this.robotModel.updateOne({ robot_id }, { lastNode: node_id });
  }

  /** 초기위치 설정 — 맵(location) + 현재 위치(pose + 최근접 노드 lastNode)를 함께 갱신. 갱신된 문서 반환. */
  async setInitialPose(
    robot_id: string, map_id: string | null, x: number, y: number, yaw: number, node_id: string | null,
  ): Promise<RobotDocument | null> {
    return this.robotModel.findOneAndUpdate(
      { robot_id },
      { location: map_id, pose_x: x, pose_y: y, yaw, lastNode: node_id },
      { new: true },
    ).exec();
  }

  /** 맵 id(location)로 로봇 조회 */
  async findByMap(map_id: string): Promise<RobotDocument[]> {
    return this.robotModel.find({ location: map_id }).exec();
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
        $set: { ...patch, online: true }, // 텔레메트리 수신 = 온라인
        $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE },
      },
      { upsert: true },
    );
  }

  /** 온라인(OFFLINE이 아닌) 로봇 목록 */
  async findOnline(): Promise<RobotDocument[]> {
    return this.robotModel.find({ status: { $ne: RobotStatus.OFFLINE } }).exec();
  }

  /** OFFLINE이 아닌 모든 로봇 (오프라인 보정 스윕용) */
  async findNotOffline(): Promise<RobotDocument[]> {
    return this.robotModel.find({ status: { $ne: RobotStatus.OFFLINE } }).lean().exec() as unknown as RobotDocument[];
  }

  /**
   * ROS 메시지로 처음 감지된 로봇을 DB에 자동 등록.
   * 이미 존재하면 OFFLINE → IDLE 로 복귀시킨다. (process() 루프에서 반환값 필요)
   */
  async autoRegister(robot_id: string): Promise<RobotDocument> {
    await this.robotModel.updateOne(
      { robot_id },
      { $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE, online: true } },
      { upsert: true },
    );
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.OFFLINE },
      { status: RobotStatus.IDLE, online: true },
    );
    return this.robotModel.findOne({ robot_id }).exec() as Promise<RobotDocument>;
  }

  /**
   * ROS 토픽 수신 감지 → OFFLINE 이면 IDLE 로 전환, 신규면 등록.
   * 그 외 활성 상태(WORKING/CHARGING 등)는 건드리지 않는다.
   */
  async bringOnlineIfOffline(robot_id: string): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id },
      { $setOnInsert: { robot_id, ip: 'auto', ros_domain_id: 0, status: RobotStatus.IDLE, online: true } },
      { upsert: true },
    );
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.OFFLINE },
      { status: RobotStatus.IDLE, online: true },
    );
  }

  /**
   * ROS 토픽 미수신 → IDLE 상태일 때만 OFFLINE 처리.
   * 활성 상태(WORKING/CHARGING 등)인 로봇은 건드리지 않는다 (태스크 로직이 별도 처리).
   */
  async setOfflineIfIdle(robot_id: string): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id, status: RobotStatus.IDLE },
      { status: RobotStatus.OFFLINE, online: false },
    );
  }

  /**
   * 강제 종료(크래시) 등 비정상 오프라인 처리.
   * WORKING 포함 모든 상태에서 OFFLINE 으로 전환하고 텔레메트리를 초기화한다.
   * 맵(location)·마지막 노드(lastNode)는 복구/추적을 위해 그대로 유지한다.
   */
  async setOffline(robot_id: string): Promise<void> {
    await this.robotModel.updateOne(
      { robot_id },
      {
        status: RobotStatus.OFFLINE,
        online: false,
        battery: null,
        pose_x: null,
        pose_y: null,
        yaw: null,
      },
    );
  }

  /**
   * 시작 스윕 — 모든 로봇을 OFFLINE 로 리셋(online=false).
   * 백엔드 기동 시 1회. 이후 텔레메트리(online 판정)가 들어와야 다시 온라인+상태를 갖는다.
   * → 재시작 전 stale online=true 가 그대로 남는 문제 방지.
   */
  async markAllOffline(): Promise<void> {
    await this.robotModel.updateMany({}, { $set: { status: RobotStatus.OFFLINE, online: false } });
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
