import { Module } from '@nestjs/common';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [RosModule],
  providers: [MapService],
  controllers: [MapController],
  exports: [MapService],
})
export class MapModule {}
