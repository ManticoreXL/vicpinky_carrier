import { Module } from '@nestjs/common';
import { RosService } from './ros.service';
import { DomainBridgeService } from './domain-bridge/domain-bridge.service';
import { VirtualRobotService } from './virtual-robot/virtual-robot.service';
import { VirtualRobotController } from './virtual-robot/virtual-robot.controller';

@Module({
  controllers: [VirtualRobotController],
  providers: [RosService, DomainBridgeService, VirtualRobotService],
  exports: [RosService, DomainBridgeService, VirtualRobotService],
})
export class RosModule {}
