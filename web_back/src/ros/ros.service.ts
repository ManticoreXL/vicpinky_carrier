import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import WebSocket = require('ws');
import {
  RosMessage,
  ServiceCallPayload,
  TopicPublishPayload,
  ActionGoalPayload,
  ActionFeedbackMsg,
  ActionResultMsg,
  SUBSCRIBED_TOPICS,
} from './ros.types';
import { DomainBridgeService } from './domain-bridge/domain-bridge.service';

// ROS 흐름 로그 스로틀(ms) — 스트리밍은 토픽별로 폭주를 막고, 이산 이벤트는 즉시(0) 남긴다.
const STREAM_THROTTLE_MS = 3000; // 액션 feedback 등 연속 수신
const TX_THROTTLE_MS = 800;      // cmd_vel 등 연속 발행

// 텔레메트리 스트림(센서/상태) — 매 프레임 들어와 태스크 흐름 로그를 가린다. 수신 로그에서 제외한다.
// (메시지 전달/구독은 그대로 — 로그만 끈다. 태스크 신호 토픽(is_loaded·victim 등)은 남는다.)
const TELEMETRY_TOPIC_RE =
  /\/(odom|scan|scan_filtered|imu|battery_state|amcl_pose|map|joint_states|follower_state|plan|robot_description|tf|tf_static)$/;

@Injectable()
export class RosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RosService.name);
  private ws: WebSocket;
  private connected = false;
  private messageHandlers: ((msg: RosMessage) => void)[] = [];
  // 발행 가로채기 — 가상 로봇(TEST-BOT) 등 rosbridge를 거치지 않는 대상 처리용.
  // 핸들러가 true를 반환하면 해당 발행은 rosbridge로 전송하지 않는다.
  private publishInterceptors: ((payload: TopicPublishPayload) => boolean)[] = [];
  private serviceCallbacks: Map<string, (res: unknown) => void> = new Map();
  private actionCallbacks: Map<string, {
    onFeedback?: (msg: ActionFeedbackMsg) => void;
    onResult?: (msg: ActionResultMsg) => void;
  }> = new Map();

  private readonly ROSBRIDGE_URL =
    process.env.ROSBRIDGE_URL ?? 'ws://localhost:9090';

  // ROS 흐름 로그 스로틀 — "방향:이름" 별 마지막 로그 시각(ms). 스트리밍 토픽 폭주 방지.
  private readonly lastLog = new Map<string, number>();
  // 서비스 호출 id → {이름,타입} — 응답 수신 시 어떤 서비스였는지 로그로 복원.
  private readonly serviceMeta = new Map<string, { name: string; type: string }>();

  constructor(private readonly bridge: DomainBridgeService) {}

  onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.ws?.close();
  }

  // ── rosbridge WebSocket 연결 ─────────────────────────────────────────────
  private connect() {
    this.ws = new WebSocket(this.ROSBRIDGE_URL);

    this.ws.on('open', () => {
      this.connected = true;
      this.subscribeAll();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString());
        this.handleIncoming(parsed);
      } catch (e) {
        this.logger.error('메시지 파싱 오류', e);
      }
    });

    this.ws.on('error', (e: Error) => {
      this.logger.error(`rosbridge 오류: ${e.message}`);
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.logger.warn('rosbridge 연결 끊김 — 3초 후 재연결');
      setTimeout(() => this.connect(), 3000);
    });
  }

  // ── 수신 메시지 라우팅 ───────────────────────────────────────────────────
  private handleIncoming(parsed: Record<string, unknown>) {
    const op = parsed['op'] as string;

    if (op === 'publish') {
      const topic = parsed['topic'] as string;
      // 텔레메트리(센서/상태 스트림)는 로그 제외 — 태스크 신호/명령만 보이게. 메시지 전달은 그대로.
      if (!TELEMETRY_TOPIC_RE.test(topic)) {
        this.flow(false, '토픽수신', topic, this.fmt(parsed['msg']), STREAM_THROTTLE_MS);
      }
      const msg: RosMessage = {
        topic,
        data: parsed['msg'] as Record<string, unknown>,
        timestamp: Date.now(),
      };
      this.messageHandlers.forEach((h) => h(msg));
    }

    if (op === 'service_response') {
      const id = parsed['id'] as string;
      // parsed['result']: rosbridge 레벨 성공/실패 (true/false)
      // parsed['values']: 실제 서비스 응답 데이터
      const values = (parsed['values'] as Record<string, unknown>) ?? {};
      const meta = this.serviceMeta.get(id);
      if (meta) {
        this.flow(false, '서비스응답', meta.name, `ok=${parsed['result'] === true} ${this.fmt(values)}`);
        this.serviceMeta.delete(id);
      }
      const cb = this.serviceCallbacks.get(id);
      if (cb) {
        cb({ ...values, _ok: parsed['result'] as boolean });
        this.serviceCallbacks.delete(id);
      }
    }

    if (op === 'action_feedback') {
      const id = parsed['id'] as string;
      const actionName = parsed['action'] as string;
      // rosbridge는 데이터를 'values'에 담음 (구버전 'feedback' 호환)
      const feedback = (parsed['values'] ?? parsed['feedback']) as Record<string, unknown>;
      this.flow(false, '액션feedback', actionName, this.fmt(feedback), STREAM_THROTTLE_MS);
      const cbs = this.actionCallbacks.get(id);
      if (cbs?.onFeedback) {
        cbs.onFeedback({ goalId: id, actionName, feedback });
      }
    }

    if (op === 'action_result') {
      const id = parsed['id'] as string;
      const actionName = parsed['action'] as string;
      const status = parsed['status'] as number;
      // rosbridge는 결과를 'values'에 담음 (구버전 'result' 호환)
      const result = (parsed['values'] ?? parsed['result']) as Record<string, unknown>;
      this.flow(false, '액션result', actionName, `status=${status} ${this.fmt(result)}`);
      const cbs = this.actionCallbacks.get(id);
      if (cbs?.onResult) {
        cbs.onResult({ goalId: id, actionName, result, status });
      }
      this.actionCallbacks.delete(id);
    }
  }

  // ── rosbridge 프로토콜 전송 헬퍼 ────────────────────────────────────────
  private send(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── 토픽 일괄 구독 ───────────────────────────────────────────────────────
  private subscribeAll() {
    // QoS(transient_local 등)는 domain_bridge 설정에서 일괄 관리한다 — 여기선 단순 구독만.
    SUBSCRIBED_TOPICS.forEach(({ name, messageType }) => {
      this.send({
        op: 'subscribe',
        topic: name,
        type: messageType,
      });
    });
  }

  // ── 동적 토픽 구독/해제 (신호 기반 완료 등 런타임 구독용) ────────────────────
  subscribe(topic: string, messageType?: string) {
    this.send({ op: 'subscribe', topic, ...(messageType ? { type: messageType } : {}) });
  }
  unsubscribe(topic: string) {
    this.send({ op: 'unsubscribe', topic });
  }

  // ── 토픽 발행 ───────────────────────────────────────────────────────────
  publish(payload: TopicPublishPayload) {
    // 가상 로봇 등 가로채기 대상이면 rosbridge로 보내지 않고 종료
    for (const intercept of this.publishInterceptors) {
      if (intercept(payload)) return;
    }
    const { topicName, messageType, message } = payload;
    this.send({
      op: 'publish',
      topic: topicName,
      type: messageType,
      msg: message,
    });
    this.flow(true, '토픽발행', topicName, `[${messageType}] ${this.fmt(message)}`, TX_THROTTLE_MS, true);
  }

  // ── ROS 흐름 로그 ───────────────────────────────────────────────────────────
  // 모든 rosbridge 송수신(토픽/서비스/액션 × 송신/수신)을 한 형식으로 남긴다:
  //   📤 …발행/호출/goal/취소  [robotId] 이름 → 도메인N (로봇측 이름)  상세
  //   📥 …수신/응답/feedback/result  [robotId] 이름 ← 도메인N           상세
  // 스트리밍(odom/scan/feedback 등)은 throttleMs로 토픽별 폭주를 막고, 이산 이벤트는
  // 즉시 남긴다. send 발행이 domain_bridge에 없으면(warnUnmapped) "로봇 미도달" 경고.
  private flow(
    send: boolean,
    kind: string,
    name: string,
    detail = '',
    throttleMs = 0,
    warnUnmapped = false,
  ): void {
    if (this.isThrottled(`${send ? 'TX' : 'RX'}:${name}`, throttleMs)) return;
    const r = this.resolveRoute(name);
    const arrow = send ? '📤' : '📥';
    const conn = send ? '→' : '←';
    const dom = r.domain != null ? `도메인 ${r.domain}` : '도메인 ?';
    const side = r.robotName && r.robotName !== name ? ` (${r.robotName})` : '';
    const line = `${arrow} ${kind} [${r.robotId}] ${name} ${conn} ${dom}${side}${detail ? `  ${detail}` : ''}`;
    if (send && warnUnmapped && !r.mapped) {
      this.logger.warn(`${line}  ⚠ domain_bridge 매핑 없음 (허브 도메인에만 발행, 로봇 미도달)`);
    } else {
      this.logger.log(line);
    }
  }

  // 토픽/서비스/액션 이름 → 담당 로봇·도메인·로봇측 이름 (domain_bridge 맵 + 폴백)
  private resolveRoute(name: string): { robotId: string; domain: number | null; robotName: string; mapped: boolean } {
    const robots = this.bridge.getMap().robots;
    for (const r of robots) {
      const cmd = r.commands.find((c) => c.hubTopic === name);   // 다운링크(허브→로봇): 발행/서비스/액션
      if (cmd) return { robotId: r.robotId, domain: cmd.toDomain, robotName: cmd.robotTopic, mapped: true };
      const tel = r.telemetry.find((t) => t.hubTopic === name);  // 업링크(로봇→허브): 센서/상태 수신
      if (tel) return { robotId: r.robotId, domain: tel.fromDomain, robotName: tel.robotTopic, mapped: true };
    }
    // 폴백: /<robotId>/... 패턴에서 로봇 추정 (브리지 맵에 없는 토픽)
    const rid = name.match(/^\/([^/]+)\//)?.[1] ?? '';
    const robot = robots.find((r) => r.robotId === rid);
    return { robotId: rid || '?', domain: robot?.robotDomain ?? null, robotName: name, mapped: false };
  }

  // 토픽별 로그 스로틀 — throttleMs 내 동일 키 재호출이면 true(억제). 0이면 항상 통과.
  private isThrottled(key: string, throttleMs: number): boolean {
    if (throttleMs <= 0) return false;
    const now = Date.now();
    if (now - (this.lastLog.get(key) ?? 0) < throttleMs) return true;
    this.lastLog.set(key, now);
    return false;
  }

  // 페이로드 요약 — JSON(긴 배열은 Array(n)으로 접고 220자 절단). 대형 맵 등 폭주 방지.
  private fmt(msg: unknown): string {
    let s: string;
    try {
      s = JSON.stringify(msg, (_k, v) => (Array.isArray(v) && v.length > 32 ? `Array(${v.length})` : v)) ?? String(msg);
    } catch {
      s = String(msg);
    }
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  }

  // ── 발행 가로채기 등록 (가상 로봇 시뮬레이터용) ──────────────────────────
  onPublish(handler: (payload: TopicPublishPayload) => boolean) {
    this.publishInterceptors.push(handler);
  }

  // ── 메시지 주입 (가상 로봇 시뮬레이터용) ─────────────────────────────────
  // rosbridge 수신 메시지와 동일하게 모든 핸들러(게이트웨이/텔레메트리/태스크매니저)에
  // 전달한다. 이를 통해 가상 로봇이 실제 로봇과 똑같은 코드 경로를 타게 된다.
  injectMessage(msg: RosMessage) {
    this.messageHandlers.forEach((h) => h(msg));
  }

  // ── 서비스 호출 ─────────────────────────────────────────────────────────
  callService(
    { serviceName, serviceType, request }: ServiceCallPayload,
    callback: (res: unknown) => void,
  ) {
    const id = `svc_${Date.now()}`;
    this.serviceCallbacks.set(id, callback);
    this.serviceMeta.set(id, { name: serviceName, type: serviceType });
    this.send({
      op: 'call_service',
      id,
      service: serviceName,
      type: serviceType,
      args: request,
    });
    this.flow(true, '서비스호출', serviceName, `[${serviceType}] ${this.fmt(request)}`);
  }

  // ── Action Goal 전송 ─────────────────────────────────────────────────────
  sendActionGoal(
    { actionName, actionType, goal }: ActionGoalPayload,
    onFeedback?: (msg: ActionFeedbackMsg) => void,
    onResult?: (msg: ActionResultMsg) => void,
  ): string {
    const id = `action_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.actionCallbacks.set(id, { onFeedback, onResult });
    this.send({
      op: 'send_action_goal',
      id,
      action: actionName,
      action_type: actionType,
      // rosbridge(ROS2)는 goal 필드를 'args' 키에서 읽는다(send_action_goal.py: message.get("args")).
      // 'goal' 로 보내면 빈 기본 goal 이 생성돼(예: target_string='') 로봇이 잘못된 값으로 처리됨.
      args: goal,
      feedback: true,
    });
    this.flow(true, '액션goal', actionName, `id=${id} [${actionType}] ${this.fmt(goal)}`);
    return id;
  }

  // ── Action Goal 취소 ─────────────────────────────────────────────────────
  cancelActionGoal(actionName: string, goalId: string) {
    this.send({
      op: 'cancel_action_goal',
      id: goalId,
      action: actionName,
    });
    this.actionCallbacks.delete(goalId);
    this.flow(true, '액션취소', actionName, `id=${goalId}`);
  }

  // ── 메시지 핸들러 등록 ───────────────────────────────────────────────────
  onMessage(handler: (msg: RosMessage) => void) {
    this.messageHandlers.push(handler);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}