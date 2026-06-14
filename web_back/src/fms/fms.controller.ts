import { Controller, Get, Post, Delete, Param, Body, Query } from '@nestjs/common';
import { FmsService } from './fms.service';
import type { CreateTaskDto } from './fms.service';
import { TaskManagerService } from './task-manager.service';

@Controller('api/fms')
export class FmsController {
  constructor(
    private readonly fmsService: FmsService,
    private readonly taskManager: TaskManagerService,
  ) {}

  @Get('tasks')
  list(
    @Query('status')   status?:   string,
    @Query('robot_id') robot_id?: string,
    @Query('limit')    limit?:    string,
  ) {
    return this.fmsService.list({
      status,
      robot_id,
      limit: limit ? +limit : undefined,
    });
  }

  @Get('tasks/:id')
  getOne(@Param('id') id: string) {
    return this.fmsService.getTask(id);
  }

  @Post('tasks')
  create(@Body() dto: CreateTaskDto) {
    return this.taskManager.enqueue(dto);
  }

  @Delete('tasks/:id/cancel')
  async cancel(@Param('id') id: string) {
    await this.fmsService.cancel(id, null);
    return { ok: true };
  }

  @Delete('tasks/:id')
  async remove(@Param('id') id: string) {
    await this.fmsService.remove(id);
    return { ok: true };
  }
}
