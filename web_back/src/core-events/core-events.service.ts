import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * 도메인 간 "단방향 통지"용 경량 이벤트 버스.
 * 모듈을 서로 import(역참조)하지 않고 느슨하게 연결하기 위한 것.
 *  예) Map(맵 재배정) ──emit──▶ FMS(진행 태스크 정리)  — 두 모듈은 서로를 모른다.
 */
export const CoreEvent = {
  /** 로봇의 배정 맵이 바뀜. payload: { robotId } */
  ROBOT_MAP_REASSIGNED: 'robot.map_reassigned',
} as const;

@Injectable()
export class CoreEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: string, payload?: unknown): void {
    this.emitter.emit(event, payload);
  }

  on(event: string, handler: (payload: any) => void): void {
    this.emitter.on(event, handler);
  }
}
