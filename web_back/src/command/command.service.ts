import { Injectable, Logger } from '@nestjs/common';
import { RosService } from '../ros/ros.service';

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface CommandStep {
  linear: number; // m/s  (+ 전진, - 후진)
  angular: number; // rad/s (+ 좌회전, - 우회전)
  duration: number; // 초
  desc: string; // 한국어 설명
}

type ProgressCb = (
  ev:
    | { type: 'plan'; steps: CommandStep[] }
    | { type: 'step'; index: number; total: number; step: CommandStep }
    | { type: 'done' }
    | { type: 'stopped' }
    | { type: 'error'; message: string },
) => void;

interface OllamaResponse {
  response?: string;
  error?: string;
}

// ── 안전 한계 ──────────────────────────────────────────────────────────────────

const MAX_LINEAR = 0.5; // m/s
const MAX_ANGULAR = 1.5; // rad/s
const PUBLISH_HZ = 10; // cmd_vel 발행 주기

const clamp = (v: number, lim: number) =>
  Math.max(-lim, Math.min(lim, Number.isFinite(v) ? v : 0));

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  private readonly ollamaUrl =
    process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  private readonly model = process.env.OLLAMA_NL_MODEL ?? 'gemma2';

  // 로봇별 실행 중단 플래그
  private readonly aborting = new Set<string>();
  private readonly running = new Set<string>();

  constructor(private readonly rosService: RosService) {}

  // ── 자연어 → 명령 시퀀스 (LLM) ──────────────────────────────────────────────

  async parsePlan(text: string): Promise<CommandStep[]> {
    const prompt = this.buildPrompt(text);

    let res: Response;
    try {
      res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          format: 'json', // 유효한 JSON 강제
          stream: false,
        }),
      });
    } catch (err: unknown) {
      const cause = (err as { cause?: unknown })?.cause;
      const detail = cause instanceof Error ? cause.message : String(cause ?? err);
      throw new Error(`LLM 연결 실패 (${this.ollamaUrl}): ${detail}`);
    }

    if (!res.ok) {
      throw new Error(`LLM 응답 오류 ${res.status}`);
    }

    const json = (await res.json()) as OllamaResponse;
    if (json.error) throw new Error(`LLM 오류: ${json.error}`);

    const steps = this.extractSteps(json.response ?? '');
    if (!steps.length) {
      throw new Error('명령을 이해하지 못했습니다 (빈 시퀀스)');
    }
    this.logger.log(`📝 명령 해석: "${text}" → ${steps.length}단계`);
    return steps;
  }

  private buildPrompt(text: string): string {
    return [
      '너는 차동 구동 로봇의 명령 플래너다.',
      '사용자의 한국어 지시를 로봇 이동 명령 시퀀스(JSON)로 변환하라.',
      '',
      '아래 형식의 JSON만 출력한다(설명 금지):',
      '{"steps":[{"linear":<m/s>,"angular":<rad/s>,"duration":<초>,"desc":"<짧은 한국어 설명>"}]}',
      '',
      '규칙:',
      '- linear: 전진 +, 후진 - (최대 0.22 m/s)',
      '- angular: 좌회전 +, 우회전 - (최대 1.0 rad/s)',
      '- 거리 ÷ 속도 = 시간. 예) 1m를 0.2m/s로 = 5초',
      '- 90도 회전은 0.5rad/s로 약 3.14초, 180도는 약 6.28초',
      '- 제자리 회전은 linear=0, 직진은 angular=0',
      '- 마지막 단계는 항상 정지: {"linear":0,"angular":0,"duration":0,"desc":"정지"}',
      '',
      `사용자 지시: "${text}"`,
    ].join('\n');
  }

  private extractSteps(raw: string): CommandStep[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 혹시 텍스트에 섞여 있으면 첫 JSON 블록 추출
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return [];
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return [];
      }
    }

    const arr = (parsed as { steps?: unknown })?.steps;
    if (!Array.isArray(arr)) return [];

    return arr
      .map((s): CommandStep => {
        const o = s as Record<string, unknown>;
        return {
          linear: clamp(Number(o.linear), MAX_LINEAR),
          angular: clamp(Number(o.angular), MAX_ANGULAR),
          duration: Math.max(0, Math.min(60, Number(o.duration) || 0)),
          desc: String(o.desc ?? ''),
        };
      })
      .filter((s) => s.desc || s.duration > 0 || s.linear !== 0 || s.angular !== 0);
  }

  // ── 시퀀스 순차 실행 ──────────────────────────────────────────────────────

  async execute(botId: string, steps: CommandStep[], cb: ProgressCb): Promise<void> {
    if (this.running.has(botId)) {
      cb({ type: 'error', message: '이미 실행 중입니다' });
      return;
    }
    this.running.add(botId);
    this.aborting.delete(botId);

    cb({ type: 'plan', steps });
    const interval = 1000 / PUBLISH_HZ;

    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.aborting.has(botId)) {
          cb({ type: 'stopped' });
          break;
        }
        const step = steps[i];
        cb({ type: 'step', index: i, total: steps.length, step });

        const end = Date.now() + step.duration * 1000;
        // duration 동안 cmd_vel 반복 발행 (로봇 안전 타임아웃 대응)
        do {
          if (this.aborting.has(botId)) break;
          this.publishCmdVel(botId, step.linear, step.angular);
          await this.sleep(interval);
        } while (Date.now() < end);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      cb({ type: 'error', message: msg });
    } finally {
      // 항상 정지 명령으로 마무리
      this.publishCmdVel(botId, 0, 0);
      this.running.delete(botId);
      if (!this.aborting.has(botId)) cb({ type: 'done' });
      this.aborting.delete(botId);
    }
  }

  stop(botId: string) {
    if (this.running.has(botId)) {
      this.aborting.add(botId);
      this.logger.log(`⛔ 명령 중단 요청: ${botId}`);
    }
    // 즉시 정지 명령
    this.publishCmdVel(botId, 0, 0);
  }

  // ── cmd_vel 발행 (로봇 타입별 메시지 형식) ────────────────────────────────

  private publishCmdVel(botId: string, linear: number, angular: number) {
    const isVicPinky = botId === 'vicpinky';
    this.rosService.publish({
      topicName: `/${botId}/cmd_vel`,
      messageType: isVicPinky
        ? 'geometry_msgs/Twist'
        : 'geometry_msgs/TwistStamped',
      message: isVicPinky
        ? {
            linear: { x: linear, y: 0.0, z: 0.0 },
            angular: { x: 0.0, y: 0.0, z: angular },
          }
        : {
            header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
            twist: {
              linear: { x: linear, y: 0.0, z: 0.0 },
              angular: { x: 0.0, y: 0.0, z: angular },
            },
          },
    });
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
