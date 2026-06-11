import { Module } from '@nestjs/common';
import { RosGateway } from './ros.gateway';
import { RosModule } from '../ros/ros.module';
import { MapModule } from '../map/map.module';
import { CommandModule } from '../command/command.module';
import { LogsModule } from '../logs/logs.module';
import { FmsModule } from '../fms/fms.module';

@Module({
  imports: [RosModule, MapModule, CommandModule, LogsModule, FmsModule],
  providers: [RosGateway],
})
export class GatewayModule {}
