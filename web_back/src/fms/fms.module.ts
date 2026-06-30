import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskHistory, TaskHistorySchema } from './task.schema';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { FmsController } from './fms.controller';
import { TaskManagerService } from './task-manager.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from './global-task-queue.service';
import { ChargingService } from './charging.service';
import { NodeLockService } from './node-lock.service';
import { TaskExecutionService } from './task-execution.service';
import { TaskPlannerService } from './task-planner.service';
import { RobotMonitorService } from './robot-monitor.service';
import { AutoTaskService } from './auto-task.service';
import { AutoDispatcherService } from './auto-dispatcher.service';
import { AutoChargerService } from './auto-charger.service';
import { RosModule } from '../ros/ros.module';
import { FleetModule } from '../fleet.module';
import { CoreEventsModule } from '../core-events/core-events.module';
import { TaskCatalogModule } from '../task-catalog/task-catalog.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TaskHistory.name, schema: TaskHistorySchema }]),
    RosModule,
    FleetModule,
    CoreEventsModule, // 맵 재배정 이벤트 구독(→ handleMapChange) — Map 모듈 역참조 제거용
    TaskCatalogModule, // 저장된 Task 정의/시퀀스 로드(runSequence)
  ],
  controllers: [FmsController],
  providers: [
    TaskRepositoryService,
    TaskStatusService,
    // 상태 저장(leaf)
    TaskManagerEventsService,
    RobotStateService,
    RobotTaskQueueService,
    // 큐
    GlobalTaskQueueService,
    // 충전소 점유 조회
    ChargingService,
    NodeLockService,
    // 주행/실행 (NavGoal+NavPublish+Navigation+RosPlan 통합)
    TaskExecutionService,
    // 할당 + 태스크별 처리 (Dispatch+Nav/Supply 핸들러+SupplyVision 통합)
    TaskPlannerService,
    // 모니터링 (Monitor+Telemetry+FallDetection 통합)
    RobotMonitorService,
    // ROS 데이터 → 태스크 자동 생성 규칙 엔진(틀)
    AutoTaskService,
    // 자동 디스패처/자동 충전 (TaskManagerService에서 분리)
    AutoDispatcherService,
    AutoChargerService,
    // 오케스트레이터(파사드)
    TaskManagerService,
  ],
  exports: [TaskRepositoryService, TaskManagerService],
})
export class FmsModule {}
