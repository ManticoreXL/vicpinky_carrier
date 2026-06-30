import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RosStep, TaskType } from '../fms/task.schema';
import {
  Task, TaskDocument,
  TaskSequence, TaskSequenceDocument,
} from './task-catalog.schema';

export interface TaskDefInput {
  name: string;
  type?: TaskType;
  preferredRobotId?: string | null;
  targetNode?: string;
  priority?: number;
  repeat?: boolean;
  triggerTopic?: string;
  triggerField?: string;
  triggerValue?: unknown;
  steps?: RosStep[];
  description?: string;
}

export interface SequenceInput {
  name: string;
  description?: string;
  items: { seq: number; task: string; robotId?: string | null }[];
}

/**
 * TaskCatalogService — 재사용 가능한 Task(정의)·TaskSequence(시나리오)의 저장/로드.
 *  실행(TaskHistory)과 분리된 '정의' 계층. 시퀀스는 populate 로 정의들을 한꺼번에 로드.
 */
@Injectable()
export class TaskCatalogService {
  private readonly logger = new Logger(TaskCatalogService.name);

  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(TaskSequence.name) private readonly seqModel: Model<TaskSequenceDocument>,
  ) {}

  // ── Task 정의 ────────────────────────────────────────────────
  async createTaskDef(dto: TaskDefInput): Promise<TaskDocument> {
    const doc = await this.taskModel.create({
      name: dto.name,
      type: dto.type ?? TaskType.MOVE,
      preferredRobotId: dto.preferredRobotId ?? null,
      targetNode: dto.targetNode ?? '',
      priority: dto.priority ?? 5,
      repeat: dto.repeat ?? false,
      triggerTopic: dto.triggerTopic ?? '',
      triggerField: dto.triggerField ?? '',
      triggerValue: dto.triggerValue ?? null,
      steps: dto.steps ?? [],
      description: dto.description ?? '',
    });
    this.logger.log(`[정의 저장] Task "${doc.name}" (${doc._id})`);
    return doc;
  }

  listTaskDefs(): Promise<TaskDocument[]> {
    return this.taskModel.find().sort({ updatedAt: -1 }).lean<TaskDocument[]>().exec();
  }

  async getTaskDef(id: string): Promise<TaskDocument> {
    const doc = await this.taskModel.findById(id).lean<TaskDocument>().exec();
    if (!doc) throw new NotFoundException(`Task 정의 없음: ${id}`);
    return doc;
  }

  async deleteTaskDef(id: string): Promise<void> {
    const res = await this.taskModel.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException(`Task 정의 없음: ${id}`);
    this.logger.warn(`[정의 삭제] Task ${id}`);
  }

  // ── TaskSequence (커스텀 시나리오) ───────────────────────────
  async createSequence(dto: SequenceInput): Promise<TaskSequenceDocument> {
    const doc = await this.seqModel.create({
      name: dto.name,
      description: dto.description ?? '',
      items: (dto.items ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((it) => ({ seq: it.seq, task: it.task, robotId: it.robotId ?? null })),
    });
    this.logger.log(`[시나리오 저장] "${doc.name}" — ${doc.items.length}단계 (${doc._id})`);
    return doc;
  }

  /** 시퀀스 목록 — 각 항목의 Task 정의까지 populate 해 한꺼번에 반환 */
  listSequences(): Promise<TaskSequenceDocument[]> {
    return this.seqModel
      .find()
      .sort({ updatedAt: -1 })
      .populate('items.task')
      .lean<TaskSequenceDocument[]>()
      .exec();
  }

  /** 단일 시퀀스 — Task 정의 populate 후 반환 ("한꺼번에 불러오기") */
  async getSequence(id: string): Promise<TaskSequenceDocument> {
    const doc = await this.seqModel
      .findById(id)
      .populate('items.task')
      .lean<TaskSequenceDocument>()
      .exec();
    if (!doc) throw new NotFoundException(`시나리오 없음: ${id}`);
    return doc;
  }

  async deleteSequence(id: string): Promise<void> {
    const res = await this.seqModel.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException(`시나리오 없음: ${id}`);
    this.logger.warn(`[시나리오 삭제] ${id}`);
  }
}
