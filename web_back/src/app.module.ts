import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RosModule } from './ros/ros.module';
import { GatewayModule } from './gateway/gateway.module';
import { VisionModule } from './vision/vision.module';
import { LogsModule } from './logs/logs.module';
import { FmsModule } from './fms/fms.module';
import { FleetModule } from './fleet.module';
import { AiModule } from './ai/ai.module';
import { VictimModule } from './victim/victim.module';
import { TaskCatalogModule } from './task-catalog/task-catalog.module';

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
    FleetModule,
    VictimModule,
    FmsModule,
    AiModule,
    TaskCatalogModule,
  ],
})
export class AppModule {}
