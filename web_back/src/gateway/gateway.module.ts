import { Module } from '@nestjs/common';
import { RosGateway } from './ros.gateway';
import { RosModule } from '../ros/ros.module';
import { MapModule } from '../map/map.module';
import { CommandModule } from '../command/command.module';

@Module({
  imports: [RosModule, MapModule, CommandModule],
  providers: [RosGateway],
})
export class GatewayModule {}
