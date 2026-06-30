import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { TaskCatalogService } from './task-catalog.service';
import type { TaskDefInput, SequenceInput } from './task-catalog.service';

/**
 * 저장된 Task 정의 / 커스텀 시나리오(TaskSequence) CRUD.
 *  - /api/fms/task-defs   : 재사용 Task 정의
 *  - /api/fms/sequences   : 커스텀 시나리오 (populate 로 정의까지 한꺼번에 로드)
 */
@Controller('api/fms')
export class TaskCatalogController {
  constructor(private readonly catalog: TaskCatalogService) {}

  // ── Task 정의 ──
  @Post('task-defs')
  createTaskDef(@Body() body: TaskDefInput) {
    return this.catalog.createTaskDef(body);
  }

  @Get('task-defs')
  listTaskDefs() {
    return this.catalog.listTaskDefs();
  }

  @Get('task-defs/:id')
  getTaskDef(@Param('id') id: string) {
    return this.catalog.getTaskDef(id);
  }

  @Delete('task-defs/:id')
  async deleteTaskDef(@Param('id') id: string) {
    await this.catalog.deleteTaskDef(id);
    return { ok: true };
  }

  // ── 커스텀 시나리오 ──
  @Post('sequences')
  createSequence(@Body() body: SequenceInput) {
    return this.catalog.createSequence(body);
  }

  @Get('sequences')
  listSequences() {
    return this.catalog.listSequences();
  }

  @Get('sequences/:id')
  getSequence(@Param('id') id: string) {
    return this.catalog.getSequence(id);
  }

  @Delete('sequences/:id')
  async deleteSequence(@Param('id') id: string) {
    await this.catalog.deleteSequence(id);
    return { ok: true };
  }
}
