import { Body, Controller, Logger, Post } from '@nestjs/common';
import { VisionService } from './vision.service';

interface AnalyzeBody {
  image: string; // data URL 또는 base64
  prompt?: string;
  botId?: string;
}

@Controller('api/vision')
export class VisionController {
  private readonly logger = new Logger(VisionController.name);

  constructor(private readonly visionService: VisionService) {}

  /** POST /api/vision/analyze — 현재 프레임 분석 */
  @Post('analyze')
  async analyze(
    @Body() body: AnalyzeBody,
  ): Promise<{ ok: boolean; text: string; message?: string }> {
    if (!body?.image) {
      return { ok: false, text: '', message: '이미지가 없습니다' };
    }
    try {
      const text = await this.visionService.analyze(body.image, body.prompt);
      return { ok: true, text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${body.botId ?? '?'}] 분석 실패: ${msg}`);
      return { ok: false, text: '', message: msg };
    }
  }
}
