import { Module } from '@nestjs/common';
import { CommandService } from './command.service';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [RosModule],
  providers: [CommandService],
  exports: [CommandService],
})
export class CommandModule {}
