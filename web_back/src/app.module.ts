import { Module } from '@nestjs/common';
import { RosModule } from './ros/ros.module';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [RosModule, GatewayModule],
})
export class AppModule {}
