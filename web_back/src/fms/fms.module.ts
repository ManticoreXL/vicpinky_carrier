import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from './task.schema';
import { FmsService } from './fms.service';
import { FmsController } from './fms.controller';
import { TaskManagerService } from './task-manager.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { RotationStateService } from '../fms-state/rotation-state.service';
import { GlobalTaskQueueService } from './queue/global-task-queue.service';
import { NavGoalService } from './navigation/nav-goal.service';
import { NodeLockService } from './node-lock/node-lock.service';
import { NavRecoveryService } from './navigation/nav-recovery.service';
import { NavigationService } from './navigation/navigation.service';
import { DispatchService } from './dispatch/dispatch.service';
import { FallDetectionService } from './monitor/fall-detection.service';
import { RobotTelemetryService } from './monitor/robot-telemetry.service';
import { RobotMonitorService } from './monitor/robot-monitor.service';
import { SupplyTaskHandler } from './dispatch/task-handlers/supply-task.handler';
import { NavigationTaskHandler } from './dispatch/task-handlers/navigation-task.handler';
import { RosModule } from '../ros/ros.module';
import { FleetModule } from '../fleet.module';
import { AiModule } from '../ai/ai.module';
// RagService는 AiModule에서 export됨

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    RosModule,
    FleetModule,
    forwardRef(() => AiModule),
  ],
  controllers: [FmsController],
  providers: [
    FmsService,
    // 상태 저장(leaf)
    TaskManagerEventsService,
    RobotStateService,
    RobotTaskQueueService,
    RotationStateService,
    // 큐
    GlobalTaskQueueService,
    // 주행/경로
    NavGoalService,
    NodeLockService,
    NavRecoveryService,
    NavigationService,
    // 배차 + 태스크별 핸들러
    DispatchService,
    SupplyTaskHandler,
    NavigationTaskHandler,
    // 감지/감시
    FallDetectionService,
    RobotTelemetryService,
    RobotMonitorService,
    // 오케스트레이터(파사드)
    TaskManagerService,
  ],
  exports: [FmsService, TaskManagerService],
})
export class FmsModule {}
