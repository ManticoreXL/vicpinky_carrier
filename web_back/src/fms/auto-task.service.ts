import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros/ros.service';
import type { RosMessage } from '../ros/ros.types';
import { GlobalTaskQueueService } from './global-task-queue.service';
import type { CreateTaskDto } from './task.dto';
import { TaskType } from './task.schema';
import { TaskCatalogService } from '../task-catalog/task-catalog.service';
import { getPath } from '../fms-shared/task-manager.helpers';

// 저장된 커스텀 태스크 정의의 "생성 조건(트리거)" — 캐시 형태
type TriggerDef = { defId: string; topic: string; field: string; value: unknown; def: Record<string, unknown> };

// 규칙 재발화 최소 간격 기본값(ms) — ROS 토픽은 고빈도(수십 Hz)라
// 같은 조건이 매 메시지마다 태스크를 만들지 않도록 쿨다운을 둔다.
const DEFAULT_COOLDOWN_MS = 30_000;

/** 규칙 평가 결과 — 만들 태스크(+중복방지 키). 조건 불일치면 null. */
type AutoTaskHit = { task: CreateTaskDto; dedupKey?: string };

/**
 * ROS 데이터 기준 "자동 태스크 생성" 규칙 1개.
 *  - topicPattern: 이 토픽에만 평가(성능). 미지정 시 모든 토픽에 대해 evaluate 호출.
 *  - evaluate:     메시지가 조건에 맞으면 생성할 태스크(+중복방지 키)를 반환, 아니면 null.
 *                  동기/비동기(Promise) 모두 가능 — 노드 조회 등 비동기 계산이 필요한 규칙을 위해.
 *  - cooldownMs:   같은 dedupKey 재발화 최소 간격(기본 DEFAULT_COOLDOWN_MS).
 */
export interface AutoTaskRule {
  id: string;
  description: string;
  topicPattern?: RegExp;
  cooldownMs?: number;
  evaluate(msg: RosMessage): AutoTaskHit | null | Promise<AutoTaskHit | null>;
}

/**
 * ── ROS 데이터 → 태스크 "자동 생성" (범용 규칙 엔진 / 틀) ──────────────────────────
 *
 *  ⚠ AUTO DISPATCHER(기존 태스크 자동 "배정/실행")와는 별개다.
 *     - AUTO DISPATCHER : 이미 큐에 있는 태스크를 로봇에 자동 배정/실행
 *     - 이 서비스       : ROS 메시지를 보고 태스크를 "새로 생성"
 *   AUTO DISPATCHER 토글이 setEnabled를 함께 호출해, ON이면 규칙이 활성화된다.
 *
 *  ※ 조난자(/victim/confirmed) → 구호 태스크 자동 생성은 여기가 아니라 VictimService가 담당한다.
 *    이유: VictimService가 임시 VICTIM 노드를 "만든 직후"라 그 노드 id를 확정적으로 알아(=race 없음)
 *    "정확한 VICTIM 노드"를 목적지로 줄 수 있기 때문. (여기서 독립 구독하면 노드 생성 전에 평가될 수 있음)
 *
 *  ⇒ 현재 활성 규칙은 없다(rules=[]). 다른 ROS 트리거가 필요하면 아래 예시처럼 규칙을 채우면 동작한다.
 *
 *  참조 안전: RosService(leaf) + GlobalTaskQueueService(같은 FmsModule)만 사용 → 신규 모듈 의존/순환 없음.
 *  안전장치: 기본 OFF(enabled일 때만 평가) + 규칙별 쿨다운(중복 폭주 방지) + 규칙 오류 격리(try/catch).
 */
@Injectable()
export class AutoTaskService implements OnModuleInit {
  private readonly logger = new Logger(AutoTaskService.name);
  private enabled = false;
  // `${ruleId}:${dedupKey}` → 마지막 발화 시각(ms)
  private readonly lastFired = new Map<string, number>();

  // ★★ 규칙을 여기에 추가하면 동작한다. (지금은 비어 있음 — victim은 VictimService가 담당) ★★
  private readonly rules: AutoTaskRule[] = [
    // ── (예시) 배터리 20% 미만 → 그 로봇 충전 태스크 ─────────────────────────────
    //   ※ 실제 저배터리 자동충전은 AutoChargerService(AUTO CHARGE)가 담당하므로 중복 주의.
    // {
    //   id: 'low-battery-charge',
    //   description: '배터리 20% 미만 → 충전 태스크 자동 생성',
    //   topicPattern: /\/battery_state$/,
    //   cooldownMs: 60_000,
    //   evaluate: (msg) => {
    //     const m = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    //     let pct = (msg.data as { percentage?: number })?.percentage ?? null;
    //     if (pct != null && pct <= 1.01) pct *= 100;                 // 0~1 정규화 → %
    //     if (!m || pct == null || pct >= 20) return null;
    //     return { task: { type: TaskType.CHARGE, preferredRobotId: m[1] }, dedupKey: m[1] };
    //   },
    // },
    // ── (예시) 조난자 보고(/victim/report, std_msgs/String JSON) → 구호 태스크 ───────
    //   ※ /victim/confirmed 기반 구호는 VictimService가 처리. 보고(report) 토픽을 쓰려면 실제 JSON 포맷 확인 후 사용.
    // {
    //   id: 'victim-report-relief',
    //   description: '조난자 보고(/victim/report JSON) → 구호 태스크',
    //   topicPattern: /^\/victim\/report$/,
    //   evaluate: (msg) => {
    //     const raw = (msg.data as { data?: string })?.data;          // std_msgs/String.data = JSON 문자열
    //     if (!raw) return null;
    //     let r: { node?: string }; try { r = JSON.parse(raw); } catch { return null; }
    //     if (!r.node) return null;
    //     return { task: { type: TaskType.PROCESS, targetNode: r.node, priority: 2 }, dedupKey: r.node };
    //   },
    // },
  ];

  // 저장된 정의의 생성 조건(트리거) 캐시 — 매 메시지 DB조회 대신 주기 갱신(refreshIfEnabled)으로 채운다.
  private triggered: TriggerDef[] = [];

  constructor(
    private readonly rosService:  RosService,
    private readonly globalQueue: GlobalTaskQueueService,
    private readonly catalog:     TaskCatalogService,
  ) {}

  onModuleInit(): void {
    // ROS 메시지를 받되, 켜져 있을 때만 평가(꺼져 있으면 부울 체크만 — 무부하).
    this.rosService.onMessage((msg) => { if (this.enabled) void this.evaluate(msg); });
  }

  // ── 트리거 캐시 갱신 — ON일 때 저장된 정의 중 triggerTopic 있는 것만 모아두고 그 토픽을 구독한다. ──
  //   (TaskManagerService의 상태 틱이 주기적으로 호출 → 새 트리거 정의가 곧 반영됨)
  async refreshIfEnabled(): Promise<void> {
    if (!this.enabled) { this.triggered = []; return; }
    const defs = (await this.catalog.listTaskDefs()) as unknown as Array<Record<string, unknown>>;
    this.triggered = defs
      .filter((d) => typeof d.triggerTopic === 'string' && (d.triggerTopic as string).trim())
      .map((d) => ({ defId: String(d._id), topic: (d.triggerTopic as string).trim(), field: (d.triggerField as string) ?? '', value: d.triggerValue ?? null, def: d }));
    for (const t of this.triggered) this.rosService.subscribe(t.topic); // 실 rosbridge 수신용(테스트는 injectMessage)
  }

  // ── on/off (AUTO DISPATCHER 토글이 함께 호출) ────────────────────────────────────
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.logger.log(`[자동생성] ${on ? `ON — 규칙 ${this.rules.length}개` : 'OFF'}`);
  }
  isEnabled(): boolean { return this.enabled; }
  /** 등록된 규칙 요약 (UI/디버그용) */
  listRules(): Array<{ id: string; description: string }> {
    return this.rules.map((r) => ({ id: r.id, description: r.description }));
  }

  // ── 규칙 평가 → 태스크 생성 (메시지 1건을 모든 규칙에 흘려본다) ──────────────────────
  private async evaluate(msg: RosMessage): Promise<void> {
    for (const rule of this.rules) {
      if (rule.topicPattern && !rule.topicPattern.test(msg.topic)) continue; // 토픽 안 맞으면 건너뜀(성능)
      let hit: AutoTaskHit | null = null;
      try {
        hit = await rule.evaluate(msg);                            // 동기/비동기 규칙 모두 지원. 오류는 격리(엔진 안 죽음)
      } catch (e) {
        this.logger.warn(`[자동생성] 규칙 '${rule.id}' 평가 오류: ${String(e)}`);
        continue;
      }
      if (!hit) continue;                                          // 조건 불일치
      if (!this.passCooldown(rule, hit.dedupKey)) continue;        // 쿨다운 내 중복 → 무시
      await this.createTask(rule, hit.task);
    }

    // ── 저장된 정의의 생성 조건(트리거) 평가 — 토픽·필드·값이 맞으면 그 커스텀 태스크를 생성 ──
    for (const t of this.triggered) {
      if (t.topic !== msg.topic) continue;
      if (!this.matches(msg.data, t.field, t.value)) continue;
      if (!this.passCooldownKey(`trigger:${t.defId}`)) continue;   // defId별 쿨다운(중복 폭주 방지)
      await this.createFromDef(t.def);
    }
  }

  // 저장된 정의(트리거 일치)로 커스텀 태스크 생성 — PENDING(=auto-dispatcher가 로봇 배차). steps 있으면 rosPlan으로 실음.
  private async createFromDef(def: Record<string, unknown>): Promise<void> {
    try {
      const steps = def.steps as unknown[] | undefined;
      const dto: CreateTaskDto = {
        label:            def.name as string,
        type:             (def.type as TaskType) ?? TaskType.MOVE,
        targetNode:       (def.targetNode as string) || undefined,
        priority:         (def.priority as number) ?? 5,
        repeat:           (def.repeat as boolean) ?? false,
        preferredRobotId: (def.preferredRobotId as string) ?? undefined,
        rosPlan:          (Array.isArray(steps) && steps.length) ? (steps as CreateTaskDto['rosPlan']) : undefined,
      };
      const task = await this.globalQueue.enqueue(dto);
      this.logger.log(`[자동생성] 트리거 '${String(def.name)}' → 태스크 ${(task as { task_id?: string }).task_id ?? ''} 생성(PENDING)`);
    } catch (e) {
      this.logger.error(`[자동생성] 트리거 정의 생성 실패: ${String(e)}`);
    }
  }

  // 메시지 매칭: field 없으면 수신만으로, value 없으면 truthy, 있으면 느슨한 동등(숫자·문자 혼용 허용).
  private matches(data: unknown, field: string, value: unknown): boolean {
    if (!field) return true;
    const actual = getPath(data, field);
    if (value === null || value === undefined) return !!actual;
    return actual === value || String(actual) === String(value);
  }
  // ── 쿨다운 — 같은 키가 cooldownMs 안에 또 맞으면 막는다(중복 태스크 폭주 방지) ──
  private passCooldownKey(key: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    const now = Date.now();
    if (now - (this.lastFired.get(key) ?? 0) < cooldownMs) return false;
    this.lastFired.set(key, now);
    return true;
  }

  private passCooldown(rule: AutoTaskRule, dedupKey?: string): boolean {
    return this.passCooldownKey(`${rule.id}:${dedupKey ?? ''}`, rule.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  }

  // ── 태스크 실제 생성 — draft면 DRAFT(등록만), 아니면 PENDING(큐 투입 → AUTO DISPATCHER가 배정) ──
  private async createTask(rule: AutoTaskRule, dto: CreateTaskDto): Promise<void> {
    try {
      const task = dto.draft ? await this.globalQueue.register(dto) : await this.globalQueue.enqueue(dto);
      this.logger.log(`[자동생성] 규칙 '${rule.id}' → 태스크 ${(task as { task_id?: string }).task_id ?? ''} (${dto.type} → ${dto.targetNode ?? '-'})`);
    } catch (e) {
      this.logger.error(`[자동생성] 규칙 '${rule.id}' 태스크 생성 실패: ${String(e)}`);
    }
  }
}
