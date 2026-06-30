import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Task, TaskSchema, TaskSequence, TaskSequenceSchema } from './task-catalog.schema';
import { TaskCatalogService } from './task-catalog.service';
import { TaskCatalogController } from './task-catalog.controller';

/**
 * TaskCatalogModule — 재사용 Task 정의 / 커스텀 시나리오 저장·로드.
 *  실행 계층(fms/TaskHistory)과 독립. 정의를 실행으로 인스턴스화하는 연결은 별도(추후).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: TaskSequence.name, schema: TaskSequenceSchema },
    ]),
  ],
  controllers: [TaskCatalogController],
  providers: [TaskCatalogService],
  exports: [TaskCatalogService],
})
export class TaskCatalogModule {}
