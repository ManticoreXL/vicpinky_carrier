import { Module } from '@nestjs/common';
import { RosModule } from '../ros/ros.module';
import { FleetModule } from '../fleet.module';
import { FmsModule } from '../fms/fms.module';
import { VictimService } from './victim.service';
import { VictimPhotoService } from './victim-photo.service';
import { VictimPhotoController } from './victim-photo.controller';

// 조난자 임시노드 — /victim/confirmed 수신 → VICTIM 노드 + 최근접 STATION 엣지 등록
//   + (AUTO DISPATCHER ON 시) VICTIM 노드로 향하는 구호 태스크 자동 생성(TaskManagerService).
// 조난자 사진 — 정찰 로봇 maps 폴더의 victim_*.jpg 를 SSH로 받아 좌표별로 서빙(VictimPhoto*).
// FmsModule은 TaskManagerService를 export하고 VictimModule을 import하지 않음 → 순환 없음.
@Module({
  imports: [RosModule, FleetModule, FmsModule],
  controllers: [VictimPhotoController],
  providers: [VictimService, VictimPhotoService],
})
export class VictimModule {}
