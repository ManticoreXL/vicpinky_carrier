import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RosModule } from './ros/ros.module';
import { GatewayModule } from './gateway/gateway.module';
import { VisionModule } from './vision/vision.module';
import { LogsModule } from './logs/logs.module';
import { FmsModule } from './fms/fms.module';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/ros_dashboard',
      }),
    }),
    RosModule,
    GatewayModule,
    VisionModule,
    LogsModule,
    FmsModule,
  ],
})
export class AppModule {}
