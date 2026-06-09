import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RosModule } from './ros/ros.module';
import { GatewayModule } from './gateway/gateway.module';
import { VisionModule } from './vision/vision.module';
import { LogsModule } from './logs/logs.module';

@Module({
  imports: [
    // MongoDB 연결 (forRootAsync: 부트 시점에 .env 반영됨)
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/ros_dashboard',
      }),
    }),
    RosModule,
    GatewayModule,
    VisionModule,
    LogsModule,
  ],
})
export class AppModule {}
