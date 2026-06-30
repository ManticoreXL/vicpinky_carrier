import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AgentService } from './agent.service';
import { RagService } from './rag.service';
// TaskHistory/Robot/Node/Log 는 "스키마"만 사용 — 각 모델을 이 모듈에서 직접 등록(아래 forFeature).
// FMS/Fleet 서비스에 의존하지 않으므로 FmsModule import 불필요(순환 제거).
import { TaskHistory, TaskHistorySchema } from '../fms/task.schema';
import { Robot, RobotSchema } from '../robot/robot.schema';
import { Node, NodeSchema } from '../topology/node.schema';
import { Log, LogSchema } from '../logs/log.schema';
import { RosModule } from '../ros/ros.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskHistory.name,  schema: TaskHistorySchema  },
      { name: Robot.name, schema: RobotSchema },
      { name: Node.name,  schema: NodeSchema  },
      { name: Log.name,   schema: LogSchema   },
    ]),
    RosModule,
  ],
  controllers: [AiController],
  providers: [AiService, AgentService, RagService],
  exports: [AiService, AgentService, RagService],
})
export class AiModule {}
