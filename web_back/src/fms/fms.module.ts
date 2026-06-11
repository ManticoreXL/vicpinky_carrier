import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from './task.schema';
import { FmsService } from './fms.service';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    RosModule,
  ],
  providers: [FmsService],
  exports: [FmsService],
})
export class FmsModule {}
