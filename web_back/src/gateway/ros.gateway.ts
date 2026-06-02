import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { RosService } from '../ros/ros.service';
import type {
  ServiceCallPayload,
  TopicPublishPayload,
  ActionGoalPayload,
  ActionCancelPayload,
} from '../ros/ros.types';

@WebSocketGateway({
  cors: { origin: '*' },   // 개발용 — 운영 시 origin 제한
  //namespace: '/ros',
})
export class RosGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RosGateway.name);

  constructor(private readonly rosService: RosService) {}

  // ── 모듈 초기화 시 ROS 메시지 → 프론트 브로드캐스트 등록 ───────────────
  onModuleInit() {
    this.rosService.onMessage((msg) => {
      const count = this.server?.sockets?.sockets?.size ?? 0;
      this.logger.debug(`브로드캐스트: ${msg.topic} → 클라이언트 ${count}개`);
      this.server?.emit('ros_message', msg);
    });
  }

  afterInit() {
    this.logger.log('WebSocket Gateway 시작 — namespace: /ros');
  }

  handleConnection(client: Socket) {
    this.logger.log(`클라이언트 연결: ${client.id}`);
    // 연결 즉시 rosbridge 상태 전송
    client.emit('ros_status', { connected: this.rosService.isConnected });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`클라이언트 해제: ${client.id}`);
  }

  // ── 프론트 → 토픽 발행 ──────────────────────────────────────────────────
  @SubscribeMessage('publish')
  handlePublish(
    @MessageBody() payload: TopicPublishPayload,
    @ConnectedSocket() client: Socket,
  ) {
    this.rosService.publish(payload);
    client.emit('publish_ack', { ok: true, topic: payload.topicName });
  }

  // ── 프론트 → 서비스 호출 ────────────────────────────────────────────────
  @SubscribeMessage('call_service')
  handleService(
    @MessageBody() payload: ServiceCallPayload,
    @ConnectedSocket() client: Socket,
  ) {
    this.rosService.callService(payload, (res) => {
      client.emit('service_response', {
        service: payload.serviceName,
        response: res,
      });
    });
  }

  // ── 프론트 → cmd_vel (터틀봇 이동 명령) ────────────────────────────────
  @SubscribeMessage('cmd_vel')
  handleCmdVel(
    @MessageBody() payload: { botId: string; linear: number; angular: number },
    @ConnectedSocket() _client: Socket,
  ) {
    this.rosService.publish({
      topicName: `/${payload.botId}/cmd_vel`,
      messageType: 'geometry_msgs/Twist',
      message: {
        linear:  { x: payload.linear,  y: 0.0, z: 0.0 },
        angular: { x: 0.0, y: 0.0, z: payload.angular },
      },
    });
  }

  // ── 프론트 → rosbridge 연결 상태 요청 ───────────────────────────────────
  @SubscribeMessage('get_status')
  handleStatus(@ConnectedSocket() client: Socket) {
    client.emit('ros_status', { connected: this.rosService.isConnected });
  }

  // ── 프론트 → Action Goal 전송 ────────────────────────────────────────────
  @SubscribeMessage('send_action')
  handleSendAction(
    @MessageBody() payload: ActionGoalPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const goalId = this.rosService.sendActionGoal(
      payload,
      (fb) => client.emit('action_feedback', fb),
      (res) => client.emit('action_result', res),
    );
    client.emit('action_accepted', { goalId, actionName: payload.actionName });
    this.logger.debug(`action accepted → ${payload.actionName} [${goalId}]`);
  }

  // ── 프론트 → Action Goal 취소 ────────────────────────────────────────────
  @SubscribeMessage('cancel_action')
  handleCancelAction(
    @MessageBody() payload: ActionCancelPayload,
    @ConnectedSocket() client: Socket,
  ) {
    this.rosService.cancelActionGoal(payload.actionName, payload.goalId);
    client.emit('action_cancelled', { goalId: payload.goalId });
  }
}