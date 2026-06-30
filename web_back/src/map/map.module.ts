import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { FleetMap, FleetMapSchema } from './fleet-map.schema';
import { FleetMapService } from './fleet-map.service';
import { FleetMapController } from './fleet-map.controller';
import { RobotPlacementService } from './robot-placement.service';
import { RosModule } from '../ros/ros.module';
import { FleetModule } from '../fleet.module';
import { CoreEventsModule } from '../core-events/core-events.module';

// map 도메인 = (1) 실시간 SLAM/점유격자 맵(MapService) + (2) 논리 맵 정의·로봇 초기위치
// 레지스트리(FleetMapService). 둘 다 "맵"을 다루므로 한 모듈로 합쳐 둔다.
// FMS 의존 제거: 맵 재배정은 CoreEventBus로 통지(FMS가 구독).
@Module({
  imports: [
    MongooseModule.forFeature([{ name: FleetMap.name, schema: FleetMapSchema }]),
    RosModule,
    FleetModule,      // RobotService/TopologyService (재시작 위치 초기화)
    CoreEventsModule, // 맵 재배정 통지
  ],
  providers: [MapService, FleetMapService, RobotPlacementService],
  controllers: [MapController, FleetMapController],
  exports: [MapService, FleetMapService],
})
export class MapModule {}
