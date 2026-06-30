import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private readonly ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  private readonly model = process.env.OLLAMA_NL_MODEL ?? 'exaone3.5:latest';

  async onModuleInit() {
    // Check if python and faster-whisper are available
    try {
      await execAsync('python3 -c "from faster_whisper import WhisperModel"');
      this.logger.log('Faster-Whisper dependency verified.');
    } catch (err) {
      this.logger.warn('Faster-Whisper not found in python3. STT might fail. Please run: pip install faster-whisper');
    }
  }

  /**
   * STT using faster-whisper via python bridge
   */
  async transcribe(file: Express.Multer.File): Promise<{ text: string }> {
    const tempPath = path.join(__dirname, `../../temp_${Date.now()}.wav`);
    fs.writeFileSync(tempPath, file.buffer);

    try {
      // Use a small python script to run faster-whisper
      const pyScript = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("base", device="cpu", compute_type="float32")
segments, info = model.transcribe("${tempPath}", beam_size=5)
print(" ".join([s.text for s in segments]).strip())
      `;
      
      const { stdout, stderr } = await execAsync(`python3 -c '${pyScript}'`);
      
      if (stderr && !stderr.includes('Thread')) { // Filter out non-error logs
        this.logger.error(`STT Python Error: ${stderr}`);
      }

      return { text: stdout.trim() };
    } catch (err) {
      this.logger.error('STT failed', err);
      throw new Error('Speech-to-Text processing failed');
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  /**
   * Ask Ollama (EXAONE 3.0)
   */
  async ask(text: string): Promise<string> {
    try {
      const response = await axios.post(`${this.ollamaUrl}/api/generate`, {
        model: this.model,
        prompt: text,
        stream: false,
        keep_alive: -1,
      });

      return response.data.response;
    } catch (err: any) {
      this.logger.error(`Ollama link failed (${this.ollamaUrl}): ${err.message}`);
      throw new Error('AI Assistant connection failed');
    }
  }

  /**
   * Task Manager용: NL 명령 파싱 또는 플릿 상태 질의
   * 태스크 명령이면 isTask=true + 구조화된 파라미터 반환
   * 일반 질문이면 isTask=false + answer 반환
   */
  async parseTaskOrChat(
    text: string,
    context: {
      nodes: Array<{ id: string; type: string }>;
      robots: Array<{ id: string; label: string; status: string; location?: string | null }>;
      activeTasks: Array<{ type: string; targetNode: string; assignedRobot?: string; status: string }>;
    },
  ): Promise<TaskAiResult> {
    const nodeList = context.nodes.length
      ? context.nodes.map(n => `${n.id}(${n.type})`).join(', ')
      : '(노드 정보 없음)';

    const robotList = context.robots.length
      ? context.robots.map(r => `${r.id}/${r.label}:${r.status}${r.location ? '@' + r.location : ''}`).join(', ')
      : '(로봇 정보 없음)';

    const taskList = context.activeTasks.length
      ? context.activeTasks.map(t => `[${t.type}→${t.targetNode},${t.assignedRobot ?? '미배정'},${t.status}]`).join(' ')
      : '없음';

    const systemPrompt = `당신은 로봇 플릿 관리 시스템(FMS) AI 어시스턴트입니다.
운영자의 입력을 분석하여 태스크 명령인지 질문인지 판단하고 JSON으로만 응답하세요.

[태스크 유형]
SUPPLY=물자공급, PROCESS=공정작업, DISTRIBUTE=배포, CHARGE=충전, SIMPLE_MOVE=단순이동

[현재 로봇] ${robotList}
[노드 목록] ${nodeList}
[진행 중 태스크] ${taskList}

태스크 명령인 경우 (예: "tb3_01을 401_7로 보내", "물자 공급 해줘"):
{"isTask":true,"type":"SUPPLY","targetNode":"401_7","preferredRobotId":"tb3_01","priority":5,"explanation":"설명"}

질문/상태확인인 경우 (예: "현재 상태는?", "어떤 로봇이 놀고 있어?"):
{"isTask":false,"answer":"답변 내용"}

preferredRobotId는 언급되지 않으면 null. priority는 1(높음)~10(낮음), 기본 5.
반드시 JSON만 출력, 다른 텍스트 금지.`;

    try {
      const response = await axios.post(`${this.ollamaUrl}/api/chat`, {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        keep_alive: -1,
      });

      const raw: string = response.data.message?.content ?? response.data.response ?? '{}';
      const parsed = JSON.parse(raw);
      return parsed as TaskAiResult;
    } catch (err: any) {
      this.logger.error(`Task AI parse failed: ${err.message}`);
      return { isTask: false, answer: 'AI 응답 처리 중 오류가 발생했습니다.' } as TaskAiResult;
    }
  }

  /**
   * RAG 버전: DB 컨텍스트를 받아 태스크 파싱 또는 질의 응답
   * FmsController의 /api/fms/ai-chat에서 호출
   */
  async parseTaskOrChatWithRag(text: string, ragContext: string): Promise<TaskAiResult> {
    const systemPrompt = `당신은 로봇 플릿 관리 시스템(FMS) AI 어시스턴트입니다.
운영자의 입력을 분석하여 태스크 명령인지 질문인지 판단하고 JSON으로만 응답하세요.

[FMS 태스크 처리 워크플로우 — 반드시 숙지]
1. 상황 발생 → 작업 큐 삽입 및 우선순위 결정 (priority 1=긴급 ~ 10=낮음)
2. 최우선 작업 수행 가능 여부 판단 (목적지 노드 존재 확인)
   → 불가 시: 관제에 알림(AlertTower), 운영자 판단 대기
3. 대기 중인 로봇 확인 (status=IDLE, ROS 토픽 수신 5초 이내)
   → 없으면: 작업 대기 후 재시도 (PENDING 상태 유지)
4. 배터리 충전량 충분 여부 확인 (기준: 20% 이상)
   → 부족 시: 관제에 해당 로봇 충전 요구 알림, 다른 로봇 탐색
5. 로봇 작업 수행 적합 상태 확인 (IDLE이고 오류 없음)
   → 부적합 시: 관제 알림(AlertTower), 운영자 조치 대기
6. 로봇에 작업 할당 → 경로 탐색(A*) → goal_pose 전송 → 상태 ASSIGNED→MOVING
7. 작업 상태 모니터링 (amcl_pose 위치 추적, 2초 주기 tick)
   → 오프라인 20s 감지 시: 태스크 FAILED, 관제 알림
   → 전복(roll/pitch > 28°) 감지 시: 즉시 관제 알림
8. 에러 발생 시: 관제 작업자 판단 후 재시도 또는 취소
9. 목적지 도착(nav2 goal reached 확인) → 태스크 COMPLETED → 로봇 IDLE 복귀 → 홈 위치로 귀환
10. 이동 시 하나하나 노드 경로에 따라 한 번에 한 노드씩 이동시켜
[태스크 유형]
SUPPLY=물자공급, PROCESS=작업, CHARGE=충전, MOVE=단순이동

[로봇 상태]
공통: IDLE=대기(작업배정가능), RETURNING=복귀중, PAUSED=일시정지, ERROR=오류, OFFLINE=오프라인(ROS연결끊김)
이동·작업: MOVING=이동중, RELIEF=구호중, TO_CHARGE=충전소이동중, CHARGING=충전중
빅핑키 캐리어: PARKED=주차됨, TO_LOAD=적재위치이동중, LOADING=상차중, LOADED=적재됨, UNLOADING=하차중, CARRIER_UP=캐리어올림, CARRIER_DOWN=캐리어내림

아래는 MongoDB에서 실시간 조회한 현재 FMS 데이터입니다. 이 데이터를 기반으로 정확하게 답변하세요:
${ragContext}

태스크 명령인 경우:
{"isTask":true,"type":"SUPPLY","targetNode":"401_7","preferredRobotId":"tb3_01","priority":5,"explanation":"설명"}

질문/상태확인인 경우:
{"isTask":false,"answer":"DB 데이터 기반 정확한 답변"}

preferredRobotId는 명시적으로 언급되지 않으면 null. priority는 1(긴급)~10(낮음), 기본 5.
반드시 JSON만 출력, 다른 텍스트 절대 금지.`;

    try {
      const response = await axios.post(`${this.ollamaUrl}/api/chat`, {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        keep_alive: -1,
      });
      const raw: string = response.data.message?.content ?? response.data.response ?? '{}';
      return JSON.parse(raw) as TaskAiResult;
    } catch (err: any) {
      this.logger.error(`RAG Task AI parse failed: ${err.message}`);
      return { isTask: false, answer: 'AI 응답 처리 중 오류가 발생했습니다.' } as TaskAiResult;
    }
  }

  /**
   * Ollama 응답을 SSE 토큰으로 클라이언트에 스트리밍
   * /api/chat endpoint 사용 (시스템 프롬프트 지원, stream:true)
   */
  async pipeStreamToResponse(
    prompt: string,
    systemPrompt: string | null,
    res: import('express').Response,
  ): Promise<void> {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const writeEvent = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        { model: this.model, messages, stream: true, options: { temperature: 0.3 }, keep_alive: -1 },
        { responseType: 'stream', timeout: 120_000 },
      );

      await new Promise<void>((resolve, reject) => {
        let buf = '';

        response.data.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const obj = JSON.parse(trimmed);
              const token: string = obj.message?.content ?? '';
              if (token) writeEvent({ token, done: false });
              if (obj.done) {
                writeEvent({ token: '', done: true });
                resolve();
              }
            } catch { /* partial JSON — skip */ }
          }
        });

        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
    } catch (err: any) {
      this.logger.error(`Stream failed: ${err.message}`);
      writeEvent({ error: err.message, done: true });
    } finally {
      res.end();
    }
  }
}

export type TaskAiResult =
  | {
      isTask: true;
      type: 'SUPPLY' | 'PROCESS' | 'DISTRIBUTE' | 'CHARGE' | 'SIMPLE_MOVE';
      targetNode: string;
      preferredRobotId: string | null;
      priority: number;
      explanation: string;
    }
  | { isTask: false; answer: string };
