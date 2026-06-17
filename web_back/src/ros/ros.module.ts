import { Module } from '@nestjs/common';
import { RosService } from './ros.service';
import { DomainBridgeService } from './domain-bridge.service';

@Module({
  providers: [RosService, DomainBridgeService],
  exports: [RosService, DomainBridgeService],
})
export class RosModule {}
