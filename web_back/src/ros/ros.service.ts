import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import WebSocket = require('ws');
import {
  RosMessage,
  ServiceCallPayload,
  TopicPublishPayload,
  SUBSCRIBED_TOPICS,
} from './ros.types';

@Injectable()
export class RosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RosService.name);
  private ws: WebSocket;
  private connected = false;
  private messageHandlers: ((msg: RosMessage) => void)[] = [];
  private serviceCallbacks: Map<string, (res: unknown) => void> = new Map();

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
    this.logger.log(`rosbridge 연결 시도: ${this.ROSBRIDGE_URL}`);
    this.ws = new WebSocket(this.ROSBRIDGE_URL);

    this.ws.on('open', () => {
      this.connected = true;
      this.logger.log('rosbridge 연결됨');
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
      // 서비스 응답 → 콜백 호출
      const id = parsed['id'] as string;
      const cb = this.serviceCallbacks.get(id);
      if (cb) {
        cb(parsed['values']);
        this.serviceCallbacks.delete(id);
      }
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
      this.logger.debug(`구독: ${name}`);
    });
  }

  // ── 토픽 발행 ───────────────────────────────────────────────────────────
  publish({ topicName, messageType, message }: TopicPublishPayload) {
    this.send({
      op: 'publish',
      topic: topicName,
      type: messageType,
      msg: message,
    });
    this.logger.debug(`publish → ${topicName}`);
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

  // ── 메시지 핸들러 등록 ───────────────────────────────────────────────────
  onMessage(handler: (msg: RosMessage) => void) {
    this.messageHandlers.push(handler);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}