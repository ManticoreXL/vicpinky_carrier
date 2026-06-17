import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from './task.schema';
import { FmsService } from './fms.service';
import { FmsController } from './fms.controller';
import { TaskManagerService } from './task-manager.service';
import { RosModule } from '../ros/ros.module';
import { FleetModule } from '../fleet/fleet.module';
import { AiModule } from '../ai/ai.module';
// RagService는 AiModule에서 export됨

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    RosModule,
    FleetModule,
    forwardRef(() => AiModule),
  ],
  controllers: [FmsController],
  providers: [FmsService, TaskManagerService],
  exports: [FmsService, TaskManagerService],
})
export class FmsModule {}
