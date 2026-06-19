import { Module } from '@nestjs/common';
import { RosService } from './ros.service';
import { DomainBridgeService } from './domain-bridge.service';
import { VirtualRobotService } from './virtual-robot.service';

@Module({
  providers: [RosService, DomainBridgeService, VirtualRobotService],
  exports: [RosService, DomainBridgeService],
})
export class RosModule {}
