import { Module } from '@nestjs/common';
import { RosService } from './ros.service';

@Module({
  providers: [RosService],
  exports: [RosService],
})
export class RosModule {}
