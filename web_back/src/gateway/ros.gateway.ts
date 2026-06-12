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
import { MapService } from '../map/map.service';
import { CommandService } from '../command/command.service';
import { LogsService } from '../logs/logs.service';
import { FmsService } from '../fms/fms.service';
import type { CreateTaskDto } from '../fms/fms.service';
import { TaskManagerService } from '../fms/task-manager.service';
import type {
  ServiceCallPayload,
  TopicPublishPayload,
  ActionGoalPayload,
  ActionCancelPayload,
} from '../ros/ros.types';

@WebSocketGateway({
  cors: { origin: '*' },   // 개발용 — 운영 시 origin 제한
  // 핑 허용시간 확대 — 로봇 영상 인코딩으로 핑이 잠깐 늦어도 끊기지 않게
  // (클라이언트 타임아웃 = pingInterval + pingTimeout = 25s + 60s = 85s)
  pingInterval: 25000,
  pingTimeout: 60000,
  //namespace: '/ros',
})
export class RosGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RosGateway.name);

  // botId → 로봇 socket.id (WebRTC 시그널링용)
  private readonly robotSockets = new Map<string, string>();

  constructor(
    private readonly rosService: RosService,
    private readonly mapService: MapService,
    private readonly commandService: CommandService,
    private readonly logsService: LogsService,
    private readonly fmsService: FmsService,
    private readonly taskManager: TaskManagerService,
  ) {}

  // ── 모듈 초기화 시 ROS 메시지 → 프론트 브로드캐스트 등록 ───────────────
  onModuleInit() {
    // 맵 토픽은 MapService가 처리 → 경량 이벤트만 발행
    this.mapService.onUpdate((botId, info) => {
      this.server?.emit('map_updated', { botId, info, timestamp: Date.now() });
    });

    this.mapService.onClear((botId) => {
      this.server?.emit('map_cleared', { botId });
    });

    this.rosService.onMessage((msg) => {
      // 맵 토픽은 socket.io로 raw 전송하지 않음 (MapService에서 PNG로 처리)
      if (/\/map$/.test(msg.topic)) return;
      this.server?.emit('ros_message', msg);
    });
  }

  afterInit() {
    this.logger.log('WebSocket Gateway 시작 — namespace: /ros');
    this.taskManager.setServer(this.server);
  }

  handleConnection(client: Socket) {
    // 연결 즉시 rosbridge 상태 전송 (로그 없음 — 노이즈 방지)
    client.emit('ros_status', { connected: this.rosService.isConnected });
  }

  handleDisconnect(client: Socket) {
    // 로봇 소켓이면 오프라인 이벤트 발행
    for (const [botId, socketId] of this.robotSockets.entries()) {
      if (socketId === client.id) {
        this.robotSockets.delete(botId);
        this.server?.emit('robot_camera_offline', { botId });
        this.logger.log(`📷 카메라 오프라인: ${botId}`);
        void this.logsService.write({
          level: 'warn', category: 'camera', botId,
          message: '카메라 오프라인',
        });
        break;
      }
    }
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

  // ── 프론트 → cmd_vel ────────────────────────────────────────────────────
  // vicpinky: geometry_msgs/Twist
  // tb3_0X  : geometry_msgs/TwistStamped
  @SubscribeMessage('cmd_vel')
  handleCmdVel(
    @MessageBody() payload: { botId: string; linear: number; angular: number },
    @ConnectedSocket() _client: Socket,
  ) {
    const isVicPinky = payload.botId === 'vicpinky';
    this.rosService.publish({
      topicName: `/${payload.botId}/cmd_vel`,
      messageType: isVicPinky ? 'geometry_msgs/Twist' : 'geometry_msgs/TwistStamped',
      message: isVicPinky
        ? {
            linear:  { x: payload.linear,  y: 0.0, z: 0.0 },
            angular: { x: 0.0, y: 0.0, z: payload.angular },
          }
        : {
            header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
            twist: {
              linear:  { x: payload.linear,  y: 0.0, z: 0.0 },
              angular: { x: 0.0, y: 0.0, z: payload.angular },
            },
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
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebRTC 시그널링 (로봇 Python ↔ 브라우저 중계)
  // ══════════════════════════════════════════════════════════════════════════

  /** 로봇(Python) → 서버: 카메라 노드 등록 */
  @SubscribeMessage('robot_register')
  handleRobotRegister(
    @MessageBody() payload: { botId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.robotSockets.set(payload.botId, client.id);
    this.logger.log(`📷 카메라 온라인: ${payload.botId}`);
    void this.logsService.write({
      level: 'info', category: 'camera', botId: payload.botId,
      message: '카메라 온라인',
    });
    client.emit('robot_registered', { ok: true });
    this.server?.emit('robot_camera_online', { botId: payload.botId });
  }

  /** 브라우저 → 서버: 특정 로봇 스트림 요청 */
  @SubscribeMessage('webrtc_request_stream')
  handleRequestStream(
    @MessageBody() payload: { botId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const robotSocketId = this.robotSockets.get(payload.botId);
    if (!robotSocketId) {
      this.logger.warn(`스트림 요청 실패: ${payload.botId} 미등록 (등록된 봇: ${[...this.robotSockets.keys()].join(', ') || '없음'})`);
      client.emit('webrtc_error', { botId: payload.botId, message: '로봇 카메라 미연결' });
      return;
    }
    // 로봇에게 "이 브라우저가 스트림을 원한다" 전달 (어떤 봇 대상인지 함께 보냄)
    this.server.to(robotSocketId).emit('browser_wants_stream', {
      browserId: client.id,
      botId: payload.botId,
    });
  }

  /** 로봇(Python) → 서버: SDP Offer 전달
   *  Python 포맷: { botId, browserId, sdp(string), type(string) }
   */
  @SubscribeMessage('webrtc_offer')
  handleOffer(
    @MessageBody() payload: { botId: string; browserId: string; sdp: string; type: string },
    @ConnectedSocket() client: Socket,
  ) {
    // 검증(경고만): 보낸 로봇 소켓이 해당 botId로 등록됐는지 — 불일치해도 중계는 함
    // (browserId로 정확히 라우팅되고, 브라우저가 botId로 다시 필터링하므로 안전)
    const expectedSocketId = this.robotSockets.get(payload.botId);
    if (expectedSocketId !== client.id) {
      this.logger.warn(
        `Offer botId 확인: ${payload.botId} 등록소켓=${expectedSocketId} ≠ 보낸소켓=${client.id} (재연결 직후일 수 있음)`,
      );
    }
    // 브라우저는 RTCSessionDescriptionInit 형태로 받아야 함 → 중첩 sdp 객체로 변환
    this.server.to(payload.browserId).emit('webrtc_offer', {
      botId: payload.botId,
      sdp: { type: payload.type, sdp: payload.sdp },
    });
  }

  /** 브라우저 → 서버: SDP Answer 전달
   *  브라우저 포맷: { botId, sdp: { type, sdp } }
   *  Python 기대 포맷: { sdp(string), type(string), browserId }
   */
  @SubscribeMessage('webrtc_answer')
  handleAnswer(
    @MessageBody() payload: { botId: string; sdp: { type: string; sdp: string } },
    @ConnectedSocket() client: Socket,
  ) {
    const robotSocketId = this.robotSockets.get(payload.botId);
    if (!robotSocketId) return;
    this.server.to(robotSocketId).emit('webrtc_answer', {
      sdp: payload.sdp.sdp,      // 플랫 문자열
      type: payload.sdp.type,    // 플랫 문자열
      browserId: client.id,
    });
    // 핸드셰이크 완료 = 스트림 연결 성립
    this.logger.log(`✅ WebRTC 연결: ${payload.botId} ↔ browser ${client.id}`);
    void this.logsService.write({
      level: 'info', category: 'webrtc', botId: payload.botId,
      message: 'WebRTC 스트림 연결', meta: { browserId: client.id },
    });
  }

  /** 브라우저 → 서버 → 로봇: ICE Candidate 중계
   *  브라우저가 보내는 이벤트: webrtc_ice
   *  로봇이 받는 이벤트명:    webrtc_ice_candidate  (Python 코드 기준)
   */
  @SubscribeMessage('webrtc_ice')
  handleIce(
    @MessageBody() payload: {
      botId: string;
      candidate: Record<string, unknown>;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const robotSocketId = this.robotSockets.get(payload.botId);
    if (robotSocketId) {
      this.server.to(robotSocketId).emit('webrtc_ice_candidate', {
        candidate: payload.candidate,
        browserId: client.id,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FMS (Fleet Management System)
  // ══════════════════════════════════════════════════════════════════════════

  /** TaskManager 경유 — 우선순위 큐 → 배터리/온라인 검증 → 자동 할당 */
  @SubscribeMessage('fms_dispatch_task')
  async handleFmsDispatch(
    @MessageBody() payload: CreateTaskDto,
  ) {
    await this.taskManager.enqueue(payload);
  }

  /** 관제 작업자: 알림 확인 */
  @SubscribeMessage('task_manager_ack')
  handleTmAck(@MessageBody() { alertId }: { alertId: string }) {
    this.taskManager.ackAlert(alertId);
  }

  /** 홈 위치 등록 (우클릭 → 초기위치 설정과 별개로, 복귀용 홈 등록) */
  @SubscribeMessage('task_manager_set_home')
  handleTmSetHome(
    @MessageBody() { robotId, x, y, yaw }: { robotId: string; x: number; y: number; yaw: number },
  ) {
    this.taskManager.setHomePosition(robotId, x, y, yaw);
    this.server.emit('task_manager_home_set', { robotId, x, y, yaw });
  }

  @SubscribeMessage('fms_cancel_task')
  async handleFmsCancel(
    @MessageBody() { taskId }: { taskId: string },
  ) {
    await this.fmsService.cancel(taskId, this.server);
  }

  @SubscribeMessage('fms_get_tasks')
  async handleFmsGetTasks(
    @MessageBody() filters: { status?: string; robotId?: string; limit?: number },
    @ConnectedSocket() client: Socket,
  ) {
    const tasks = await this.fmsService.list(filters);
    client.emit('fms_tasks', tasks);
  }

  // ── Nav2: 목표 지점 전송 ─────────────────────────────────────────────────
  @SubscribeMessage('nav_send_goal')
  handleNavGoal(
    @MessageBody() { robotId, x, y, yaw }: { robotId: string; x: number; y: number; yaw: number },
  ) {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName: `/${robotId}/goal_pose`,
      messageType: 'geometry_msgs/PoseStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          position: { x, y, z: 0 },
          orientation: {
            x: 0, y: 0,
            z: Math.sin(yaw / 2),
            w: Math.cos(yaw / 2),
          },
        },
      },
    });
  }

  // ── Nav2: 초기 위치 설정 (AMCL) ─────────────────────────────────────────
  @SubscribeMessage('nav_set_initialpose')
  handleNavInitialPose(
    @MessageBody() { robotId, x, y, yaw }: { robotId: string; x: number; y: number; yaw: number },
  ) {
    const now = Date.now() / 1000;
    this.rosService.publish({
      topicName: `/${robotId}/initialpose`,
      messageType: 'geometry_msgs/PoseWithCovarianceStamped',
      message: {
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          pose: {
            position: { x, y, z: 0 },
            orientation: {
              x: 0, y: 0,
              z: Math.sin(yaw / 2),
              w: Math.cos(yaw / 2),
            },
          },
          covariance: [
            0.25, 0, 0, 0, 0, 0,
            0, 0.25, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0.06853891945200942,
          ],
        },
      },
    });
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

  // ══════════════════════════════════════════════════════════════════════════
  // 자연어 명령 (LLM → cmd_vel 시퀀스)
  // ══════════════════════════════════════════════════════════════════════════

  /** 프론트 → 서버: 자연어 명령 실행 */
  @SubscribeMessage('nl_command')
  async handleNlCommand(
    @MessageBody() payload: { botId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { botId, text } = payload;
    if (!botId || !text?.trim()) {
      client.emit('nl_command_error', { botId, message: '명령이 비어 있습니다' });
      return;
    }

    // 1) 자연어 → 시퀀스 파싱
    let steps;
    try {
      steps = await this.commandService.parsePlan(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      client.emit('nl_command_error', { botId, message });
      return;
    }

    // 2) 순차 실행 — 진행상황을 모든 클라이언트에 브로드캐스트
    void this.commandService.execute(botId, steps, (ev) => {
      switch (ev.type) {
        case 'plan':
          this.server.emit('nl_command_plan', { botId, text, steps: ev.steps });
          break;
        case 'step':
          this.server.emit('nl_command_progress', {
            botId, index: ev.index, total: ev.total, step: ev.step,
          });
          break;
        case 'done':
          this.server.emit('nl_command_done', { botId });
          break;
        case 'stopped':
          this.server.emit('nl_command_stopped', { botId });
          break;
        case 'error':
          this.server.emit('nl_command_error', { botId, message: ev.message });
          break;
      }
    });
  }

  /** 프론트 → 서버: 자연어 명령 중단(긴급정지) */
  @SubscribeMessage('nl_command_stop')
  handleNlCommandStop(@MessageBody() payload: { botId: string }) {
    this.commandService.stop(payload.botId);
  }
}