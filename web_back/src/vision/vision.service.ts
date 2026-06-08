import { Injectable, Logger } from '@nestjs/common';

// ── 타입 ─────────────────────────────────────────────────────────────────────

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);

  private readonly ollamaUrl =
    process.env.OLLAMA_URL ?? 'http://localhost:11434';
  private readonly model = process.env.OLLAMA_VISION_MODEL ?? 'llava';

  private readonly defaultPrompt =
    '이 카메라 영상을 한국어로 간결하게 설명해줘. ' +
    '사람(인명), 장애물, 화재·연기, 위험 요소가 보이면 우선적으로 알려줘.';

  /**
   * base64 이미지를 LLaVA에 보내 분석 텍스트를 받는다.
   * @param imageBase64  data URL (data:image/jpeg;base64,...) 또는 순수 base64
   */
  async analyze(imageBase64: string, prompt?: string): Promise<string> {
    // data URL 접두어 제거 (Ollama는 순수 base64만 받음)
    const img = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const body = {
      model: this.model,
      prompt: prompt?.trim() || this.defaultPrompt,
      images: [img],
      stream: false,
    };

    const started = Date.now();
    const res = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama 응답 오류 ${res.status}: ${text}`);
    }

    const json = (await res.json()) as OllamaGenerateResponse;
    if (json.error) {
      throw new Error(`Ollama 오류: ${json.error}`);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const result = (json.response ?? '').trim();
    this.logger.log(`🔍 비전 분석 완료 (${this.model}, ${elapsed}s, ${result.length}자)`);
    return result;
  }
}
