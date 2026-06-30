import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { RagService } from './rag.service';

export interface AgentAction {
  tool:   string;
  args:   Record<string, unknown>;
  result: unknown;
}

export interface AgentResult {
  reply:   string;
  actions: AgentAction[];
  mode?:   'native' | 'text';
}

/**
 * EXAONE 기반 RAG 챗 어시스턴트.
 *
 * function-calling(도구 호출)을 사용하지 않는다. RAG 컨텍스트만으로 한국어 답변을 생성하는
 * 조회/설명 전용이다. (로봇 제어·태스크 발행은 UI/테스트 탭에서 직접 수행)
 */
@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger    = new Logger(AgentService.name);
  private readonly ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  // EXAONE 단일 모델 (Qwen·도구호출 제거)
  private readonly model = process.env.OLLAMA_CHAT_MODEL ?? process.env.OLLAMA_NL_MODEL ?? 'exaone3.5:latest';

  constructor(private readonly ragService: RagService) {}

  // ── 시작 시 모델 적재 상태 검증 ──
  async onModuleInit(): Promise<void> {
    try {
      const res = await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 5_000 });
      const installed: string[] = (res.data?.models ?? []).map((m: { name: string }) => m.name);
      if (installed.includes(this.model)) {
        this.logger.log(`[모델검증] EXAONE = ${this.model} ✓ 설치됨`);
      } else {
        this.logger.error(
          `[모델검증] EXAONE = ${this.model} ✗ Ollama에 없음! 설치된 모델: [${installed.join(', ') || '없음'}] → "ollama pull ${this.model}" 필요`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[모델검증] Ollama(${this.ollamaUrl}) 연결 실패: ${err.message}`);
    }
  }

  // ── 메인 엔트리 — RAG 컨텍스트 기반 한국어 답변 (도구 호출 없음) ──────────────
  async run(userText: string): Promise<AgentResult> {
    const ragContext = await this.ragService.buildContext();
    const reply = await this.chat(userText, ragContext);
    return { reply, actions: [], mode: 'text' };
  }

  // ── EXAONE 대화 (RAG) ────────────────────────────────────────────────────────
  private async chat(userText: string, ragContext: string): Promise<string> {
    const systemPrompt = `[최우선 규칙 — 반드시 준수]
1. 반드시 한국어로만 답변하세요. 영어·중국어·일본어 등 다른 언어 절대 사용 금지.
2. 아래 [현재 시스템 상태] 데이터에 있는 정보만 사용하세요. 데이터에 없는 내용은 절대 추측하거나 생성하지 마세요.
3. 노드 ID는 반드시 [토폴로지 노드] 목록에 있는 실제 ID를 그대로 사용하세요.
   "station1", "dock_main", "작업장" 등 목록에 없는 이름 절대 생성 금지.
   로봇의 근접 노드는 [근접노드: XXX] 형태로 이미 제공됩니다 — 그 XXX 값을 그대로 쓰세요.
4. JSON 출력 금지. 자연스러운 한국어 구어체 문장으로만 답하세요.
5. 마크다운문법 출력 금지
당신은 로봇 관제 시스템(FMS) AI 어시스턴트입니다.

[현재 시스템 상태]
${ragContext}`;

    try {
      const res = await axios.post(`${this.ollamaUrl}/v1/chat/completions`, {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        options: { temperature: 0.1 },
        keep_alive: -1,
      });
      let content = res.data.choices[0].message.content ?? '답변을 생성하지 못했습니다.';

      // 혹시라도 JSON 형태로 뱉었을 경우 텍스트만 추출
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.answer) content = parsed.answer;
        }
      } catch { /* 파싱 실패 시 원본 사용 */ }

      return content;
    } catch (err: any) {
      this.logger.error(`대화 생성 실패: ${err.message}`);
      return 'AI 연결에 실패했습니다.';
    }
  }
}
