import { Controller, Get, Post, Body } from '@nestjs/common';
import { VirtualRobotService } from './virtual-robot.service';

/** 가상 테스트봇(TEST-BOT*) 제어 — 적합도/충전 시나리오 테스트용 배터리 수동 설정. */
@Controller('api/test-robot')
export class VirtualRobotController {
  constructor(private readonly virtualRobot: VirtualRobotService) {}

  /** 현재 테스트봇 배터리 목록 */
  @Get('battery')
  list(): { robotId: string; battery: number }[] {
    return this.virtualRobot.getBatteries();
  }

  /** 테스트봇 배터리 수동 설정 (0~100%) */
  @Post('battery')
  set(@Body() body: { robotId: string; percentage: number }): { ok: boolean } {
    return { ok: this.virtualRobot.setBattery(body.robotId, Number(body.percentage)) };
  }

  /** 테스트봇 전복(ERROR) 시뮬레이션 토글 — true면 ERROR 전환 + 보유 태스크 글로벌 큐 반납 */
  @Post('error')
  setError(@Body() body: { robotId: string; error: boolean }): { ok: boolean } {
    return { ok: this.virtualRobot.setError(body.robotId, !!body.error) };
  }

  /** 테스트봇 적재 신호 — SUPPLY 비전 적재 완료(/omx/vision/is_loaded=true) 1회 주입 → 대기 중 보급 완료 */
  @Post('loaded')
  setLoaded(@Body() body: { robotId: string }): { ok: boolean } {
    return { ok: this.virtualRobot.signalLoaded(body.robotId) };
  }
}
