import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RosService } from './ros.service';
import type { RosMessage, TopicPublishPayload } from './ros.types';

// ── 가상 테스트 로봇 (TEST-BOT1 ~ TEST-BOT4) ───────────────────────────────────
//
// rosbridge / 실제 ROS 없이 백엔드 안에서만 동작하는 시뮬레이션 로봇 4대.
// 기본 동작은 터틀봇과 동일하다:
//   - 주기적으로 odom / amcl_pose / battery_state 를 주입 → 항상 온라인 + 지도 표시
//   - goal_pose 를 받으면 직선으로 이동하며 amcl_pose 를 주입 → 태스크매니저가 도착 감지
//   - cmd_vel=0 (정지) / initialpose (초기위치) 도 실제 로봇과 동일하게 처리
// 실제 로봇과 같은 메시지 파이프라인(RosService)을 타므로 텔레메트리·태스크 로직이
// 그대로 적용되며, 이동은 항상 목표에 도달하므로 태스크는 "항상 성공"한다.

const TEST_BOT_IDS = ['TEST-BOT1', 'TEST-BOT2', 'TEST-BOT3', 'TEST-BOT4'] as const;
const TICK_MS       = 200;    // 시뮬레이션 주기
const HEARTBEAT_MS  = 1_000;  // 정지 중에도 온라인 유지용 텔레메트리 주기
const MOVE_SPEED    = 0.6;    // m/s — 터틀봇 정도의 주행 속도
const ARRIVE_EPS    = 0.05;   // 도착 판정 거리 (m)

interface BotState {
  pose:    { x: number; y: number; yaw: number };
  goal:    { x: number; y: number; yaw: number } | null;
  moving:  boolean;
  battery: number; // %
}

@Injectable()
export class VirtualRobotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VirtualRobotService.name);

  // robotId → 가상 로봇 상태 (맵 프레임)
  private readonly bots = new Map<string, BotState>();

  private tickTimer: NodeJS.Timeout | null = null;
  private hbTimer:   NodeJS.Timeout | null = null;

  constructor(private readonly rosService: RosService) {}

  onModuleInit() {
    // 시작 위치를 살짝 어긋나게 배치해 4대가 겹치지 않도록 함 (이후 initialpose로 조정 가능)
    TEST_BOT_IDS.forEach((id, i) => {
      this.bots.set(id, {
        pose:    { x: i * 0.5, y: 0, yaw: 0 },
        goal:    null,
        moving:  false,
        battery: 100,
      });
    });

    // /TEST-BOTx/* 발행은 rosbridge로 보내지 않고 시뮬레이터가 처리
    this.rosService.onPublish((p) => this.handlePublish(p));

    this.hbTimer   = setInterval(() => this.emitTelemetry(), HEARTBEAT_MS);
    this.tickTimer = setInterval(() => this.step(), TICK_MS);

    this.logger.log(`가상 테스트봇 ${TEST_BOT_IDS.join(', ')} 시작 (rosbridge 미경유, 항상 성공)`);
    this.emitTelemetry(); // 첫 텔레메트리 즉시 주입 → 바로 온라인 표시
  }

  onModuleDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.hbTimer)   clearInterval(this.hbTimer);
  }

  // ── 발행 가로채기 ─────────────────────────────────────────────────────────
  private handlePublish(p: TopicPublishPayload): boolean {
    const m = p.topicName.match(/^\/([^/]+)\/(.+)$/);
    if (!m) return false;
    const bot = this.bots.get(m[1]);
    if (!bot) return false; // TEST-BOTx 대상 아님 → 정상 발행

    const id  = m[1];
    const sub = m[2];
    const msg = p.message as Record<string, any>;

    if (sub === 'goal_pose') {
      const pos = msg?.pose?.position;
      const ori = msg?.pose?.orientation;
      if (pos?.x != null) {
        bot.goal   = { x: pos.x, y: pos.y ?? 0, yaw: quatToYaw(ori) };
        bot.moving = true;
        this.logger.log(`${id} goal_pose → (${pos.x.toFixed(2)}, ${(pos.y ?? 0).toFixed(2)})`);
      }
    } else if (sub === 'initialpose') {
      const pos = msg?.pose?.pose?.position;
      const ori = msg?.pose?.pose?.orientation;
      if (pos?.x != null) {
        bot.pose = { x: pos.x, y: pos.y ?? 0, yaw: quatToYaw(ori) };
        this.emitOne(id, bot, Date.now()); // 초기위치 즉시 반영
      }
    } else if (/cmd_vel$/.test(sub)) {
      // cmd_vel=0 정지 명령 → 이동 중단 (가상 로봇은 즉시 멈춘다)
      const tw  = msg?.twist ?? msg;
      const lin = tw?.linear, ang = tw?.angular;
      const isZero = (lin?.x ?? 0) === 0 && (lin?.y ?? 0) === 0 && (ang?.z ?? 0) === 0;
      if (isZero) bot.moving = false;
    }
    return true; // 처리 완료 → rosbridge 발행 생략
  }

  // ── 시뮬레이션 한 스텝 (전체 봇) ──────────────────────────────────────────
  private step() {
    const now = Date.now();
    for (const [id, bot] of this.bots) {
      if (!bot.moving || !bot.goal) continue;

      const dx   = bot.goal.x - bot.pose.x;
      const dy   = bot.goal.y - bot.pose.y;
      const dist = Math.hypot(dx, dy);
      const stepLen = MOVE_SPEED * (TICK_MS / 1000);

      if (dist <= Math.max(stepLen, ARRIVE_EPS)) {
        bot.pose = { ...bot.goal }; // 도착 — 항상 성공
        bot.moving = false;
      } else {
        bot.pose.x  += (dx / dist) * stepLen;
        bot.pose.y  += (dy / dist) * stepLen;
        bot.pose.yaw = Math.atan2(dy, dx);
      }
      this.emitOne(id, bot, now);
    }
  }

  // ── 텔레메트리 주입 (전체 봇) ──────────────────────────────────────────────
  private emitTelemetry() {
    const now = Date.now();
    for (const [id, bot] of this.bots) this.emitOne(id, bot, now);
  }

  // odom / amcl_pose / battery_state 한 대 분 주입
  private emitOne(id: string, bot: BotState, now: number) {
    if (bot.moving) bot.battery = Math.max(20, bot.battery - 0.02); // 천천히 소모
    this.rosService.injectMessage(this.poseMsg(id, bot, 'amcl_pose', now));
    this.rosService.injectMessage(this.poseMsg(id, bot, 'odom', now));
    this.rosService.injectMessage({
      topic: `/${id}/battery_state`,
      data: { percentage: bot.battery },
      timestamp: now,
    });
  }

  private poseMsg(id: string, bot: BotState, kind: 'amcl_pose' | 'odom', now: number): RosMessage {
    const { x, y, yaw } = bot.pose;
    return {
      topic: `/${id}/${kind}`,
      data: {
        pose: {
          pose: {
            position:    { x, y, z: 0 },
            orientation: yawToQuat(yaw),
          },
        },
      },
      timestamp: now,
    };
  }
}

// ── 쿼터니언 ↔ yaw 헬퍼 ───────────────────────────────────────────────────────
function quatToYaw(ori: { x?: number; y?: number; z?: number; w?: number } | undefined): number {
  if (!ori) return 0;
  const x = ori.x ?? 0, y = ori.y ?? 0, z = ori.z ?? 0, w = ori.w ?? 1;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

function yawToQuat(yaw: number) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}
