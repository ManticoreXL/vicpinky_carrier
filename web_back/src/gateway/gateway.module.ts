import { Module } from '@nestjs/common';
import { RosGateway } from './ros.gateway';
import { RosModule } from '../ros/ros.module';
import { MapModule } from '../map/map.module';

@Module({
  imports: [RosModule, MapModule],
  providers: [RosGateway],
})
export class GatewayModule {}
