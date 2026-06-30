import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RobotService } from '../robot/robot.service';
import { TopologyService } from '../topology/topology.service';
import { MapService } from './map.service';
import { VirtualRobotService } from '../ros/virtual-robot/virtual-robot.service';

/**
 * 백엔드 시작 시(1회) 로봇 DB 위치 초기화.
 *  - location ← 맵 배정(map_id)  (MapService.getAssignments — "maps에서 주입")
 *  - pose_x/pose_y/yaw ← 그 로봇 lastNode의 좌표 (마지막으로 있던 노드 위치로 복원)
 *  - 테스트봇은 시뮬레이터 내부 pose도 같이 맞춰 주입 amcl이 lastNode에서 시작하도록 한다
 *    (안 그러면 가상봇이 기본 시작좌표로 amcl을 쏴 DB pose를 덮어쓴다).
 *
 * onApplicationBootstrap = 모든 모듈 onModuleInit 이후 → 맵 배정 로드/토폴로지 백필/가상봇 기동 완료 후 실행.
 */
@Injectable()
export class RobotPlacementService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RobotPlacementService.name);

  constructor(
    private readonly robotService: RobotService,
    private readonly topology:     TopologyService,
    private readonly mapService:   MapService,
    private readonly virtualRobot: VirtualRobotService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const assignments = this.mapService.getAssignments(); // robotId → map_id
    const robots = await this.robotService.findAll();
    let placed = 0;

    for (const r of robots) {
      const patch: Partial<{ location: string; pose_x: number; pose_y: number; yaw: number }> = {};

      // 1) location ← 맵 배정(map_id)
      const mapId = assignments[r.robot_id];
      if (mapId) patch.location = mapId;

      // 2) pose ← lastNode 좌표
      if (r.lastNode) {
        const node = await this.topology.findNodeById(r.lastNode);
        if (node) {
          patch.pose_x = node.x;
          patch.pose_y = node.y;
          patch.yaw = node.yaw ?? 0;
          // 테스트봇: 시뮬레이터 내부 pose도 동일하게(주입 amcl 시작점)
          if (r.robot_id.startsWith('TEST')) this.virtualRobot.setPose(r.robot_id, node.x, node.y, node.yaw ?? 0);
        }
      }

      if (Object.keys(patch).length) {
        await this.robotService.setPlacement(r.robot_id, patch);
        placed++;
      }
    }

    this.logger.log(`[시작 초기화] 로봇 ${placed}대 — location(맵)/pose(lastNode 좌표) 주입`);
  }
}
