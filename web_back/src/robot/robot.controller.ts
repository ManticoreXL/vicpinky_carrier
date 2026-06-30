import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { RobotService } from './robot.service';
import { Robot, RobotStatus } from './robot.schema';

@Controller('api/fleet/robots')
export class RobotController {
  constructor(private readonly robotService: RobotService) {}

  @Get()
  findAll(@Query('map_id') map_id?: string) {
    return map_id ? this.robotService.findByMap(map_id) : this.robotService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.robotService.findById(id); }

  @Post()
  create(@Body() dto: Partial<Robot>) { return this.robotService.create(dto); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<Robot>) {
    return this.robotService.update(id, dto);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body('status') status: RobotStatus) {
    return this.robotService.updateStatus(id, status);
  }

  @Patch(':id/location')
  updateNode(@Param('id') id: string, @Body('node_id') node_id: string) {
    return this.robotService.updateNode(id, node_id);
  }

  @Patch(':id/rename')
  renameRobot(@Param('id') id: string, @Body('new_id') new_id: string) {
    return this.robotService.renameRobotId(id, new_id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.robotService.remove(id); }
}
