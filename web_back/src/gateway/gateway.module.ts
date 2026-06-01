import { Module } from '@nestjs/common';
import { RosGateway } from './ros.gateway';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [RosModule],
  providers: [RosGateway],
})
export class GatewayModule {}
