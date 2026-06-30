import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Robot, RobotSchema } from './robot/robot.schema';
import { Node, NodeSchema } from './topology/node.schema';
import { Edge, EdgeSchema } from './topology/edge.schema';
import { TaskHistory, TaskHistorySchema } from './fms/task.schema';
import { RobotService } from './robot/robot.service';
import { TopologyService } from './topology/topology.service';
import { PathfindingService } from './pathfinding/pathfinding.service';
import { TelemetryService } from './telemetry/telemetry.service';
import { NodeOccupancyService } from './node-occupancy/node-occupancy.service';
import { CollisionAvoidanceService } from './collision-avoidance/collision-avoidance.service';
import { RobotController } from './robot/robot.controller';
import { TopologyController } from './topology/topology.controller';
import { RosModule } from './ros/ros.module';

// 플릿 인프라 집합 모듈 — robot / topology / pathfinding / telemetry /
// node-occupancy 도메인을 한데 묶어 제공한다.
// (논리 맵 정의·SLAM 맵은 map 도메인(MapModule)이 담당)
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Robot.name, schema: RobotSchema },
      { name: Node.name,  schema: NodeSchema  },
      { name: Edge.name,  schema: EdgeSchema  },
      { name: TaskHistory.name,  schema: TaskHistorySchema  },
    ]),
    RosModule, // TelemetryService가 ROS 토픽 구독
  ],
  providers: [
    RobotService,
    TopologyService,
    PathfindingService,
    TelemetryService,
    NodeOccupancyService,
    CollisionAvoidanceService, // 1-ahead 우선순위 양보(주행 단계 충돌 회피)
  ],
  controllers: [RobotController, TopologyController],
  exports: [
    RobotService,
    TopologyService,
    PathfindingService,
    TelemetryService,
    NodeOccupancyService,
    CollisionAvoidanceService,
  ],
})
export class FleetModule {}
