import { Module } from '@nestjs/common';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { RosModule } from '../ros/ros.module';
import { FmsModule } from '../fms/fms.module';

@Module({
  imports: [RosModule, FmsModule],
  providers: [MapService],
  controllers: [MapController],
  exports: [MapService],
})
export class MapModule {}
