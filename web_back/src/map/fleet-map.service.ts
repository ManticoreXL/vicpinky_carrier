import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FleetMap, FleetMapDocument } from './fleet-map.schema';

@Injectable()
export class FleetMapService {
  constructor(
    @InjectModel(FleetMap.name) private readonly mapModel: Model<FleetMapDocument>,
  ) {}

  async create(dto: Partial<FleetMap>): Promise<FleetMapDocument> {
    return this.mapModel.create(dto);
  }

  async findAll(): Promise<FleetMapDocument[]> {
    return this.mapModel.find().lean().exec() as unknown as FleetMapDocument[];
  }

  async findById(map_id: string): Promise<FleetMapDocument | null> {
    return this.mapModel.findOne({ map_id }).exec();
  }

  async update(map_id: string, dto: Partial<FleetMap>): Promise<FleetMapDocument> {
    const doc = await this.mapModel.findOneAndUpdate({ map_id }, dto, { new: true });
    if (!doc) throw new NotFoundException(`Map ${map_id} 없음`);
    return doc;
  }

  async remove(map_id: string): Promise<void> {
    await this.mapModel.deleteOne({ map_id });
  }

  /** 특정 로봇의 초기 위치 조회 */
  async getInitPosition(map_id: string, robot_id: string) {
    const m = await this.mapModel.findOne({ map_id }).exec();
    return m?.init_position?.[robot_id] ?? null;
  }

  /** 특정 로봇의 초기 위치 등록/수정 */
  async setInitPosition(
    map_id: string,
    robot_id: string,
    pos: { x: number; y: number; yaw: number },
  ): Promise<FleetMapDocument> {
    const doc = await this.mapModel.findOneAndUpdate(
      { map_id },
      { $set: { [`init_position.${robot_id}`]: pos } },
      { new: true, upsert: false },
    );
    if (!doc) throw new NotFoundException(`Map ${map_id} 없음`);
    return doc;
  }

  /** 특정 로봇의 초기 위치 삭제 */
  async deleteInitPosition(map_id: string, robot_id: string): Promise<FleetMapDocument> {
    const doc = await this.mapModel.findOneAndUpdate(
      { map_id },
      { $unset: { [`init_position.${robot_id}`]: '' } },
      { new: true },
    );
    if (!doc) throw new NotFoundException(`Map ${map_id} 없음`);
    return doc;
  }
}
