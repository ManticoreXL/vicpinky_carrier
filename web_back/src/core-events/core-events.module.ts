import { Module } from '@nestjs/common';
import { CoreEventBus } from './core-events.service';

// 도메인 간 느슨한 연결용 이벤트 버스(leaf). 어느 모듈에도 의존하지 않는다.
@Module({
  providers: [CoreEventBus],
  exports: [CoreEventBus],
})
export class CoreEventsModule {}
