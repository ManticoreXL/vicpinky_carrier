import { Controller, Post, UseInterceptors, UploadedFile, Body, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { RagService } from './rag.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly ragService: RagService,
  ) {}

  @Post('stt')
  @UseInterceptors(FileInterceptor('file'))
  async transcribe(@UploadedFile() file: Express.Multer.File) {
    return this.aiService.transcribe(file);
  }

  @Post('ask')
  async ask(@Body('text') text: string) {
    const response = await this.aiService.ask(text);
    return { response };
  }

  /**
   * RAG + SSE 스트리밍 엔드포인트
   * - DB 현황을 자동으로 조회해 시스템 프롬프트에 주입
   * - 토큰을 실시간으로 클라이언트에 전달 (text/event-stream)
   * Body: { prompt: string, systemPrompt?: string }
   */
  @Post('stream')
  async stream(
    @Body() body: { prompt: string; systemPrompt?: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // RAG: DB 현황 조회 후 시스템 프롬프트에 자동 삽입
    const ragContext = await this.ragService.buildContext();
    const workflowKnowledge = `
[FMS 태스크 처리 워크플로우]
1. 상황 발생 → 작업 큐 삽입 (priority 1=긴급~10=낮음)
2. 목적지 노드 존재 확인 → 없으면 AlertTower
3. IDLE 로봇 탐색(ROS 토픽 5초 이내) → 없으면 PENDING 대기
4. 배터리 20% 이상 확인 → 부족 시 충전 요구 알림
5. 로봇 상태 IDLE·오류없음 확인 → 부적합 시 AlertTower
6. 작업 할당 → A* 경로탐색 → goal_pose 전송 → ASSIGNED→MOVING
7. amcl_pose 위치 추적(2초 tick) → 오프라인 20s→FAILED, 전복감지→알림
8. 에러 발생 → 관제 조치
9. 목적지 0.5m 이내 도착 → COMPLETED → 로봇 IDLE → 홈 귀환`;

    const basePrompt = body.systemPrompt ?? '';
    const enrichedSystemPrompt = [basePrompt, workflowKnowledge, ragContext]
      .filter(Boolean).join('\n\n');

    await this.aiService.pipeStreamToResponse(body.prompt, enrichedSystemPrompt, res);
  }
}
