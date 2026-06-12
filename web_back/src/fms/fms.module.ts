import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from './task.schema';
import { FmsService } from './fms.service';
import { TaskManagerService } from './task-manager.service';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    RosModule,
  ],
  providers: [FmsService, TaskManagerService],
  exports: [FmsService, TaskManagerService],
})
export class FmsModule {}
