import { Injectable, OnModuleInit } from '@nestjs/common';
import { RosService } from '../../ros/ros.service';
import type { RosMessage } from '../../ros/ros.types';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { NavigationService } from '../navigation/navigation.service';
import { FallDetectionService } from './fall-detection.service';
import { Quaternion } from '../../geometry/pose';

/**
 * ROS 토픽 → 로봇 상태 라우터.
 *
 * 모든 ROS 메시지를 받아 토픽별로 분류한다:
 *   - 임의 토픽 → lastSeen 갱신(온라인 판정용)
 *   - battery_state → 배터리 캐시
 *   - amcl_pose → 위치 캐시 + NavigationService.onAmclPose (주행 진행/도착 판정)
 *   - imu → FallDetectionService.onImu (전복 감지)
 */
@Injectable()
export class RobotTelemetryService implements OnModuleInit {
  constructor(
    private readonly rosService:     RosService,
    private readonly robotState:     RobotStateService,
    private readonly navigation:     NavigationService,
    private readonly fallDetection:  FallDetectionService,
  ) {}

  onModuleInit() {
    this.rosService.onMessage((msg) => this.handle(msg));
  }

  private handle(msg: RosMessage): void {
    const now = Date.now();

    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch) {
      this.robotState.patchCache(botMatch[1], { lastSeen: now }, now);
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      let pct = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      this.robotState.patchCache(batMatch[1], { batteryPct: pct }, now);
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos = poseData?.position;
      const ori = poseData?.orientation;
      if (pos?.x != null) {
        const yaw = ori ? Quaternion.from(ori).yaw : 0;
        this.robotState.patchCache(id, { posX: pos.x, posY: pos.y ?? 0, yaw, lastAmclMs: now }, now);
        this.navigation.onAmclPose(id, pos.x, pos.y ?? 0, yaw);
      }
    }

    const imuMatch = msg.topic.match(/^\/([^/]+)\/imu$/);
    if (imuMatch) {
      const ori = (msg.data as { orientation?: { x?: number; y?: number; z?: number; w?: number } })?.orientation;
      if (ori) this.fallDetection.onImu(imuMatch[1], ori);
    }
  }
}
