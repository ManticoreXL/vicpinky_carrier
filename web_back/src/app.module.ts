import { Module } from '@nestjs/common';
import { RosModule } from './ros/ros.module';
import { GatewayModule } from './gateway/gateway.module';
import { VisionModule } from './vision/vision.module';

@Module({
  imports: [RosModule, GatewayModule, VisionModule],
})
export class AppModule {}
