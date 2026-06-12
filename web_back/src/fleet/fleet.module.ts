import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Robot, RobotSchema } from './robot.schema';
import { FleetMap, FleetMapSchema } from './fleet-map.schema';
import { Node, NodeSchema } from './node.schema';
import { Edge, EdgeSchema } from './edge.schema';
import { RobotService } from './robot.service';
import { FleetMapService } from './fleet-map.service';
import { TopologyService } from './topology.service';
import { RobotController } from './robot.controller';
import { FleetMapController } from './fleet-map.controller';
import { TopologyController } from './topology.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Robot.name,    schema: RobotSchema    },
      { name: FleetMap.name, schema: FleetMapSchema },
      { name: Node.name,     schema: NodeSchema     },
      { name: Edge.name,     schema: EdgeSchema     },
    ]),
  ],
  providers: [RobotService, FleetMapService, TopologyService],
  controllers: [RobotController, FleetMapController, TopologyController],
  exports: [RobotService, FleetMapService, TopologyService],
})
export class FleetModule {}
