import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Robot, RobotSchema } from './robot.schema';
import { FleetMap, FleetMapSchema } from './fleet-map.schema';
import { Node, NodeSchema } from './node.schema';
import { Edge, EdgeSchema } from './edge.schema';
import { Task, TaskSchema } from '../fms/task.schema';
import { RobotService } from './robot.service';
import { FleetMapService } from './fleet-map.service';
import { TopologyService } from './topology.service';
import { TelemetryService } from './telemetry.service';
import { CollisionAvoidanceService } from './collision-avoidance.service';
import { RobotController } from './robot.controller';
import { FleetMapController } from './fleet-map.controller';
import { TopologyController } from './topology.controller';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Robot.name,    schema: RobotSchema    },
      { name: FleetMap.name, schema: FleetMapSchema },
      { name: Node.name,     schema: NodeSchema     },
      { name: Edge.name,     schema: EdgeSchema     },
      { name: Task.name,     schema: TaskSchema     },
    ]),
    RosModule, // TelemetryService가 ROS 토픽 구독
  ],
  providers: [
    RobotService,
    FleetMapService,
    TopologyService,
    TelemetryService,
    CollisionAvoidanceService,
  ],
  controllers: [RobotController, FleetMapController, TopologyController],
  exports: [
    RobotService,
    FleetMapService,
    TopologyService,
    TelemetryService,
    CollisionAvoidanceService,
  ],
})
export class FleetModule {}
