import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { Task, TaskSchema } from '../fms/task.schema';
import { Robot, RobotSchema } from '../fleet/robot.schema';
import { Node, NodeSchema } from '../fleet/node.schema';
import { Log, LogSchema } from '../logs/log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name,  schema: TaskSchema  },
      { name: Robot.name, schema: RobotSchema },
      { name: Node.name,  schema: NodeSchema  },
      { name: Log.name,   schema: LogSchema   },
    ]),
  ],
  controllers: [AiController],
  providers: [AiService, RagService],
  exports: [AiService, RagService],
})
export class AiModule {}
