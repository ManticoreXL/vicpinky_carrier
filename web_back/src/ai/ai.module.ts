import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AgentService } from './agent.service';
import { RagService } from './rag.service';
import { Task, TaskSchema } from '../fms/task.schema';
import { Robot, RobotSchema } from '../robot/robot.schema';
import { Node, NodeSchema } from '../topology/node.schema';
import { Log, LogSchema } from '../logs/log.schema';
import { FmsModule } from '../fms/fms.module';
import { FleetModule } from '../fleet.module';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name,  schema: TaskSchema  },
      { name: Robot.name, schema: RobotSchema },
      { name: Node.name,  schema: NodeSchema  },
      { name: Log.name,   schema: LogSchema   },
    ]),
    forwardRef(() => FmsModule),
    FleetModule,
    RosModule,
  ],
  controllers: [AiController],
  providers: [AiService, AgentService, RagService],
  exports: [AiService, AgentService, RagService],
})
export class AiModule {}
