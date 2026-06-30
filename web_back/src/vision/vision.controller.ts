import { Body, Controller, Get, Logger, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import axios from 'axios';
import { VisionService } from './vision.service';

interface AnalyzeBody {
  image: string; // data URL 또는 base64
  prompt?: string;
  botId?: string;
}

@Controller('api/vision')
export class VisionController {
  private readonly logger = new Logger(VisionController.name);

  // 라즈베리파이 lerobot 비전(Flask MJPEG) 주소 — 환경변수로 덮어쓰기
  private readonly policyVisionUrl = process.env.POLICY_VISION_URL ?? 'http://10.10.14.24:5000';

  constructor(private readonly visionService: VisionService) {}

  /**
   * GET /api/vision/policy-stream        → 기본(/video_feed)
   * GET /api/vision/policy-stream/:cam   → OMX 카메라별(/video_feed/front, /wrist)
   * 라즈베리파이 MJPEG를 FMS 백엔드가 그대로 중계한다. 프론트는 단일 출처(:3001)로
   * `<img>`만 띄우면 되고, 파이 IP는 백엔드 env로 관리된다.
   */
  @Get('policy-stream')
  policyStream(@Res() res: Response): Promise<void> {
    return this.proxyStream(`${this.policyVisionUrl}/video_feed`, res);
  }

  @Get('policy-stream/:cam')
  policyStreamCam(@Param('cam') cam: string, @Res() res: Response): Promise<void> {
    // 경로 인젝션 방지 — 영숫자/언더스코어만 허용, 그 외는 front로 폴백
    const safe = /^[a-z0-9_]+$/i.test(cam) ? cam : 'front';
    return this.proxyStream(`${this.policyVisionUrl}/video_feed/${safe}`, res);
  }

  // MJPEG 스트림 중계 공통 로직
  private async proxyStream(url: string, res: Response): Promise<void> {
    try {
      const upstream = await axios.get(url, {
        responseType: 'stream',
        timeout: 0, // 무한 스트림 — 읽기 타임아웃 없음
      });
      res.setHeader(
        'Content-Type',
        (upstream.headers['content-type'] as string) ?? 'multipart/x-mixed-replace; boundary=frame',
      );
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'close');
      upstream.data.pipe(res);
      upstream.data.on('error', () => res.end());
      res.on('close', () => upstream.data.destroy()); // 클라이언트 끊기면 업스트림도 정리
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[policy-stream] 파이 비전 연결 실패(${url}): ${msg}`);
      if (!res.headersSent) res.status(502).end();
    }
  }

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
