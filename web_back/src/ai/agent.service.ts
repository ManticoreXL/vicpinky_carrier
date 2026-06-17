import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TaskManagerService } from '../fms/task-manager.service';
import { FmsService } from '../fms/fms.service';
import { TopologyService } from '../fleet/topology.service';
import { RobotService } from '../fleet/robot.service';
import { TelemetryService } from '../fleet/telemetry.service';
import { DomainBridgeService } from '../ros/domain-bridge.service';
import { RagService } from './rag.service';
import { TaskType, TaskStatus } from '../fms/task.schema';

// ── 툴 정의 ──────────────────────────────────────────────────────────────────

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description: '로봇에게 이동/공급/가공/충전 태스크를 지시합니다. 로봇을 특정 위치로 이동시키거나 작업을 명령할 때 사용합니다.',
      parameters: {
        type: 'object',
        properties: {
          target_node: { type: 'string', description: '목적지 노드 ID (예: "401_7", "dock_1")' },
          task_type:   { type: 'string', enum: ['MOVE', 'SUPPLY', 'PROCESS', 'CHARGE'], description: '태스크 유형. 단순 이동은 MOVE' },
          robot_id:    { type: 'string', description: '특정 로봇 지정 (예: "tb3_01"). 없으면 자동 배정' },
          priority:    { type: 'number', description: '우선순위 1(긴급)~10(낮음). 기본값 5' },
        },
        required: ['target_node', 'task_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: '진행 중인 태스크를 취소하고 로봇을 정지시킵니다.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '취소할 태스크의 _id' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_robot',
      description: '특정 로봇을 즉시 정지시킵니다.',
      parameters: {
        type: 'object',
        properties: {
          robot_id: { type: 'string', description: '정지할 로봇 ID (예: "tb3_01")' },
        },
        required: ['robot_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'return_home',
      description: '로봇을 등록된 홈 위치로 복귀시킵니다.',
      parameters: {
        type: 'object',
        properties: {
          robot_id: { type: 'string', description: '복귀시킬 로봇 ID' },
        },
        required: ['robot_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_robots',
      description: '모든 로봇의 현재 상태, 위치, 배터리를 조회합니다.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nodes',
      description: '맵의 노드(위치) 목록을 조회합니다. 노드 좌표(x,y)와 타입(WAYPOINT/STATION/CHARGER)이 포함됩니다.',
      parameters: {
        type: 'object',
        properties: {
          map_id: { type: 'string', description: '맵 ID (없으면 전체)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_active_tasks',
      description: '현재 진행 중이거나 대기 중인 태스크 목록을 조회합니다.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lock_node',
      description: '특정 노드를 잠금/잠금 해제합니다. 잠긴 노드는 경유지에서 제외됩니다.',
      parameters: {
        type: 'object',
        properties: {
          node_id:   { type: 'string' },
          is_locked: { type: 'boolean', description: 'true=잠금, false=해제' },
        },
        required: ['node_id', 'is_locked'],
      },
    },
  },
];

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

@Injectable()
export class AgentService {
  private readonly logger    = new Logger(AgentService.name);
  private readonly ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  
  // ── 하이브리드 모델 설정 ──
  private readonly cmdModel = process.env.OLLAMA_NL_MODEL ?? 'qwen2.5:7b'; // 툴 전용
  private readonly chatModel = 'exaone3.5:latest'; // 답변/조회 전용

  constructor(
    private readonly taskManager:         TaskManagerService,
    private readonly fmsService:          FmsService,
    private readonly topologyService:     TopologyService,
    private readonly robotService:        RobotService,
    private readonly telemetryService:    TelemetryService,
    private readonly domainBridgeService: DomainBridgeService,
    private readonly ragService:          RagService,
  ) {}

  // ── 메인 엔트리 ────────────────────────────────────────────────────────────

  async run(userText: string): Promise<AgentResult> {
    const ragContext = await this.ragService.buildContext();
    const actions: AgentAction[] = [];

    // 1. 의도 분류 (명령 vs 질문)
    const isCommand = await this.classifyIntent(userText);
    
    if (isCommand) {
      this.logger.log(`[Agent] 의도: 명령(Command) → Qwen 2.5 도구 호출`);
      return this.executeCommandFlow(userText, ragContext);
    } else {
      this.logger.log(`[Agent] 의도: 질문(Chat) → EXAONE 3.5 답변`);
      const reply = await this.executeChatFlow(userText, ragContext);
      return { reply, actions, mode: 'text' };
    }
  }

  // ── 의도 분류 (빠른 모델 활용) ───────────────────────────────────────────
  private async classifyIntent(text: string): Promise<boolean> {
    const prompt = `사용자의 입력이 시스템을 변경하거나 로봇을 제어하는 명령인지, 아니면 단순한 상태 조회나 질문인지 판단하세요.
명령 예시: "tb3_01을 문 앞으로 보내", "1번 로봇 정지해", "물자 공급해줘"
질문 예시: "지금 배터리 제일 많은 로봇이 뭐야?", "현재 상태 알려줘", "문 앞이 어디야?"

반드시 JSON으로만 답하세요: {"isCommand": true} 또는 {"isCommand": false}`;

    try {
      const res = await axios.post(`${this.ollamaUrl}/v1/chat/completions`, {
        model: this.cmdModel, // 판단은 빠른 Qwen으로
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }],
        response_format: { type: 'json_object' },
        options: { temperature: 0 },
      });
      const content = res.data.choices[0].message.content;
      return JSON.parse(content).isCommand === true;
    } catch {
      return true; // 기본값: 명령으로 간주하여 도구 호출 시도
    }
  }

  // ── 제어 명령 흐름 (Qwen 2.5 + Native Tools) ──────────────────────────────
  private async executeCommandFlow(userText: string, ragContext: string): Promise<AgentResult> {
    const actions: AgentAction[] = [];
    const systemPrompt = `당신은 로봇 플릿 관리 시스템(FMS) 관제 AI입니다.
[현재 상태]\n${ragContext}
사용자의 명령을 완수하기 위해 제공된 도구(tool)를 즉시 실행하세요. 필요한 노드 ID나 로봇 ID는 현재 상태를 참고하세요.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ];

    try {
      // 1. 도구 호출
      const res = await axios.post(`${this.ollamaUrl}/v1/chat/completions`, {
        model: this.cmdModel,
        messages,
        tools: AGENT_TOOLS,
        options: { temperature: 0.1 },
      });

      const msg = res.data.choices[0].message;
      
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return { reply: msg.content ?? '실행할 도구를 찾지 못했습니다.', actions, mode: 'native' };
      }

      // 2. 도구 실행
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
        
        let result: unknown;
        try {
          result = await this.executeTool(name, args);
        } catch (err: any) {
          result = { error: err.message };
        }
        actions.push({ tool: name, args, result });
      }

      // 3. EXAONE 3.5를 통한 상황 브리핑 생성
      const briefing = await this.generateBriefing(userText, actions, ragContext);
      return { reply: briefing, actions, mode: 'native' };

    } catch (err: any) {
      this.logger.error(`명령 실행 실패: ${err.message}`);
      return { reply: '명령 실행 중 오류가 발생했습니다.', actions, mode: 'native' };
    }
  }

  // ── 질문/대화 흐름 (EXAONE 3.5) ──────────────────────────────────────────
  private async executeChatFlow(userText: string, ragContext: string): Promise<string> {
    const systemPrompt = `[언어 규칙 — 최우선 적용]
반드시 한국어로만 답변하세요. 영어·중국어·일본어 등 다른 언어는 절대 사용하지 마세요.

당신은 로봇 관제 시스템(FMS) AI 어시스턴트 EXAONE입니다.
아래 DB 현황을 기반으로 사용자의 질문에 정확하게 한국어로 답변하세요.

[답변 규칙]
- 로봇 위치는 반드시 근접 노드 ID로 표현하세요: "XXX 노드 근처" 또는 "XXX 노드에 위치"
- 좌표(x, y)만 단독으로 나열하지 말고 노드 ID를 앞에 붙이세요.
- 예시: "tb3_04는 현재 '중간 중단' 노드 근처(2.81, -6.02)에 있습니다."
- JSON 형태 출력 금지. 자연스러운 한국어 문장으로만 답하세요.

[현재 시스템 상태]\n${ragContext}`;

    try {
      const res = await axios.post(`${this.ollamaUrl}/v1/chat/completions`, {
        model: this.chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText }
        ],
        options: { temperature: 0.3 },
      });
      let content = res.data.choices[0].message.content ?? '답변을 생성하지 못했습니다.';
      
      // 혹시라도 JSON 형태로 뱉었을 경우 파싱해서 텍스트만 추출
      try {
        const jsonMatch = content.match(/\\{[\s\S]*\\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.answer) {
             content = parsed.answer;
          }
        }
      } catch (e) {
        // 파싱 실패하면 그냥 원본 텍스트 사용
      }
      return content;
    } catch (err: any) {
      this.logger.error(`대화 생성 실패: ${err.message}`);
      return 'AI 연결에 실패했습니다.';
    }
  }

  // ── 최종 브리핑 생성 (EXAONE 3.5) ────────────────────────────────────────
  private async generateBriefing(userText: string, actions: AgentAction[], ragContext: string): Promise<string> {
    const prompt = `[언어 규칙] 반드시 한국어로만 답변하세요. 다른 언어 절대 사용 금지.

사용자가 "${userText}"라고 명령했고, 시스템은 다음 작업들을 수행했습니다:
${JSON.stringify(actions, null, 2)}

[현재 상태 참고]\n${ragContext}

이 결과를 한국어로 간결하게 보고하세요. 어떤 로봇/노드를 선택했는지 포함하세요.`;

    try {
      const res = await axios.post(`${this.ollamaUrl}/v1/chat/completions`, {
        model: this.chatModel,
        messages: [{ role: 'user', content: prompt }],
        options: { temperature: 0.3 },
      });
      return res.data.choices[0].message.content ?? '명령이 처리되었습니다.';
    } catch {
      return '작업이 성공적으로 처리되었습니다.';
    }
  }

  // ── 툴 실행 ────────────────────────────────────────────────────────────────
  private async executeTool(name: string, args: Record<string, any>): Promise<unknown> {
    switch (name) {
      case 'dispatch_task': {
        const robotId = (args.robot_id === 'null' || !args.robot_id) ? undefined : args.robot_id;
        const task = await this.taskManager.enqueue({
          type:             args.task_type as TaskType,
          targetNode:       args.target_node as string,
          preferredRobotId: robotId,
          priority:         args.priority ?? 5,
        });
        return {
          ok:      true,
          task_id: (task as any)._id?.toString(),
          message: `태스크 생성: ${args.task_type} → ${args.target_node}${robotId ? ' / ' + robotId : ' (자동배정)'}`,
        };
      }
      case 'cancel_task':
        await this.taskManager.cancelTask(args.task_id as string);
        return { ok: true, message: `태스크 ${args.task_id} 취소 완료` };
      case 'stop_robot':
        return this.taskManager.stopRobot(args.robot_id as string);
      case 'return_home':
        return this.taskManager.returnHomeNow(args.robot_id as string);
      case 'get_robots': {
        const [robots, nodes] = await Promise.all([
          this.robotService.findAll(),
          this.topologyService.findAllNodes(),
        ]);
        return robots.map(r => {
          const tel     = this.telemetryService.getTelemetry(r.robot_id);
          const battery = r.battery ?? tel?.battery ?? null;
          const posX    = r.pose_x  ?? tel?.posX    ?? null;
          const posY    = r.pose_y  ?? tel?.posY    ?? null;

          let nearestNode: string | null = null;
          if (posX != null && posY != null && nodes.length) {
            let minDist = Infinity;
            for (const n of nodes) {
              const d = Math.hypot(n.x - posX, n.y - posY);
              if (d < minDist) { minDist = d; nearestNode = n.node_id; }
            }
          }

          return {
            id:          r.robot_id,
            status:      r.status,
            location:    r.location,
            battery:     battery != null ? `${battery.toFixed(0)}%` : '미상',
            nearestNode,
            position:    posX != null ? { x: +posX.toFixed(2), y: +(posY ?? 0).toFixed(2) } : null,
          };
        });
      }
      case 'get_nodes': {
        const nodes = await this.topologyService.findAllNodes(args.map_id as string | undefined);
        return nodes.map(n => ({
          id: n.node_id, type: n.type, map: n.map_id,
          x: +n.x.toFixed(3), y: +n.y.toFixed(3),
        }));
      }
      case 'get_active_tasks': {
        const all = await this.fmsService.list({ limit: 50 });
        return (all as any[])
          .filter(t => [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.RUNNING].includes(t.status))
          .map(t => ({
            id: t._id?.toString(), type: t.type, status: t.status,
            target: t.targetNode, robot: t.assignedRobotId,
          }));
      }
      case 'lock_node':
        await this.taskManager.lockNode(args.node_id as string, args.is_locked as boolean);
        return { ok: true, message: `노드 ${args.node_id} ${args.is_locked ? '잠금' : '잠금 해제'}` };
      default:
        throw new Error(`알 수 없는 툴: ${name}`);
    }
  }
}

