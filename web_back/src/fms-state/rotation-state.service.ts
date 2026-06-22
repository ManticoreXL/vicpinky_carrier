import { Injectable } from '@nestjs/common';

/** 코너 회전 상태 (로봇별) */
export interface RotatingState {
  nextNodeId: string;
  targetYaw:  number;
  phase:      'stopping' | 'rotating'; // stopping: 정지 대기, rotating: 회전 중(yaw 수렴 대기)
  timer:      NodeJS.Timeout;
}

/**
 * 코너 회전 상태(인메모리) 단일 소유자.
 *
 * 90°급 코너에서 "정지 → 제자리 회전 → 다음 노드 진행" 단계를 추적한다.
 * NavigationService(회전 시작/수렴 판정)와 NavRecoveryService(AMCL 중단 시 정리)가
 * 함께 접근하므로, 순환 의존을 피하려고 별도 leaf 서비스로 둔다.
 */
@Injectable()
export class RotationStateService {
  private readonly state = new Map<string, RotatingState>();

  has(robotId: string): boolean { return this.state.has(robotId); }
  get(robotId: string): RotatingState | undefined { return this.state.get(robotId); }
  set(robotId: string, s: RotatingState): void { this.state.set(robotId, s); }

  /** 회전 상태 제거 + 보류 타이머 정리 */
  clear(robotId: string): void {
    const s = this.state.get(robotId);
    if (s) { clearTimeout(s.timer); this.state.delete(robotId); }
  }

  /** 타이머 정리 없이 항목만 제거 (수렴 성공 등으로 타이머를 직접 처리한 경우) */
  delete(robotId: string): void { this.state.delete(robotId); }
}
