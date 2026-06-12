import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { RobotService } from './robot.service';
import { Robot, RobotStatus } from './robot.schema';

@Controller('api/fleet/robots')
export class RobotController {
  constructor(private readonly robotService: RobotService) {}

  @Get()
  findAll() { return this.robotService.findAll(); }

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
  updateLocation(@Param('id') id: string, @Body('node_id') node_id: string) {
    return this.robotService.updateLocation(id, node_id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.robotService.remove(id); }
}
