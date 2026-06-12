import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { FleetMapService } from './fleet-map.service';
import { FleetMap } from './fleet-map.schema';

@Controller('api/fleet/maps')
export class FleetMapController {
  constructor(private readonly fleetMapService: FleetMapService) {}

  @Get()
  findAll() { return this.fleetMapService.findAll(); }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.fleetMapService.findById(id); }

  @Post()
  create(@Body() dto: Partial<FleetMap>) { return this.fleetMapService.create(dto); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<FleetMap>) {
    return this.fleetMapService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.fleetMapService.remove(id); }

  @Get(':id/init-position/:robotId')
  getInitPosition(@Param('id') id: string, @Param('robotId') robotId: string) {
    return this.fleetMapService.getInitPosition(id, robotId);
  }

  @Patch(':id/init-position/:robotId')
  setInitPosition(
    @Param('id') id: string,
    @Param('robotId') robotId: string,
    @Body() pos: { x: number; y: number; yaw: number },
  ) {
    return this.fleetMapService.setInitPosition(id, robotId, pos);
  }
}
