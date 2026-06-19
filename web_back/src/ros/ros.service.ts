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
      this.logger.debug(`수신: ${topic}`);
      const msg: RosMessage = {
        topic,
        data: parsed['msg'] as Record<string, unknown>,
        timestamp: Date.now(),
      };
      this.messageHandlers.forEach((h) => h(msg));
    }

    if (op === 'service_response') {
      const id = parsed['id'] as string;
      const cb = this.serviceCallbacks.get(id);
      if (cb) {
        // parsed['result']: rosbridge 레벨 성공/실패 (true/false)
        // parsed['values']: 실제 서비스 응답 데이터
        const values = (parsed['values'] as Record<string, unknown>) ?? {};
        cb({ ...values, _ok: parsed['result'] as boolean });
        this.serviceCallbacks.delete(id);
      }
    }

    if (op === 'action_feedback') {
      const id = parsed['id'] as string;
      const cbs = this.actionCallbacks.get(id);
      if (cbs?.onFeedback) {
        cbs.onFeedback({
          goalId: id,
          actionName: parsed['action'] as string,
          // rosbridge는 데이터를 'values'에 담음 (구버전 'feedback' 호환)
          feedback: (parsed['values'] ?? parsed['feedback']) as Record<string, unknown>,
        });
      }
    }

    if (op === 'action_result') {
      const id = parsed['id'] as string;
      const cbs = this.actionCallbacks.get(id);
      if (cbs?.onResult) {
        cbs.onResult({
          goalId: id,
          actionName: parsed['action'] as string,
          // rosbridge는 결과를 'values'에 담음 (구버전 'result' 호환)
          result: (parsed['values'] ?? parsed['result']) as Record<string, unknown>,
          status: parsed['status'] as number,
        });
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
    SUBSCRIBED_TOPICS.forEach(({ name, messageType }) => {
      this.send({
        op: 'subscribe',
        topic: name,
        type: messageType,
      });
    });
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
    this.logger.debug(`publish → ${topicName}`);
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
    this.send({
      op: 'call_service',
      id,
      service: serviceName,
      type: serviceType,
      args: request,
    });
    this.logger.debug(`service call → ${serviceName}`);
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
      goal,
      feedback: true,
    });
    this.logger.debug(`action goal → ${actionName} [${id}]`);
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
    this.logger.debug(`action cancel → ${actionName} [${goalId}]`);
  }

  // ── 메시지 핸들러 등록 ───────────────────────────────────────────────────
  onMessage(handler: (msg: RosMessage) => void) {
    this.messageHandlers.push(handler);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}