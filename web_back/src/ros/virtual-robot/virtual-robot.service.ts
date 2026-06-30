import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros.service';
import type { RosMessage, TopicPublishPayload } from '../ros.types';
import { Quaternion } from '../../geometry/pose';

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

// ── 배터리 (적합도·충전 테스트용 — 적합도 탭에서 수동 오버라이드 가능) ──
const BAT_START = [100, 72, 48, 22]; // 봇별 시작 배터리(%) — 편차를 둬 추천/충전 로직 테스트
const BAT_DRAIN = 0.06;  // 이동 중 텔레메트리 주입당 소모(%) — 정지 중엔 수동 설정값 유지
const BAT_MIN   = 5;     // 최소 배터리(%)

// SUPPLY 비전 적재 완료 토픽 — task-planner.service.ts 의 LOADED_TOPIC 와 동일(로봇별 아님, 단일 비전 허브).
// 적재 버튼이 이 토픽에 {data:true} 를 1회 주입하면 TaskPlannerService.onSupplyLoaded 가 대기 중 SUPPLY 를 완료시킨다.
const LOADED_TOPIC = '/omx/vision/is_loaded';

interface BotState {
  pose:    { x: number; y: number; yaw: number };
  goal:    { x: number; y: number; yaw: number } | null;
  moving:  boolean;
  battery: number; // %
  error:   boolean; // true면 전복 자세(IMU roll 90°) 주입 → 백엔드 전복 감지로 ERROR 시뮬레이션
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
        battery: BAT_START[i] ?? 100,
        error:   false,
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
        bot.goal   = { x: pos.x, y: pos.y ?? 0, yaw: Quaternion.from(ori).yaw };
        bot.moving = true;
        this.logger.log(`${id} goal_pose → (${pos.x.toFixed(2)}, ${(pos.y ?? 0).toFixed(2)})`);
      }
    } else if (sub === 'initialpose') {
      const pos = msg?.pose?.pose?.position;
      const ori = msg?.pose?.pose?.orientation;
      if (pos?.x != null) {
        bot.pose = { x: pos.x, y: pos.y ?? 0, yaw: Quaternion.from(ori).yaw };
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

  /** 테스트봇 배터리 수동 설정(적합도 탭 등에서 호출). 즉시 텔레메트리 반영. @returns 성공 여부 */
  setBattery(robotId: string, pct: number): boolean {
    const bot = this.bots.get(robotId);
    if (!bot) return false;
    bot.battery = Math.max(0, Math.min(100, pct));
    this.emitOne(robotId, bot, Date.now()); // 즉시 반영
    this.logger.log(`${robotId} 배터리 수동 설정 → ${bot.battery}%`);
    return true;
  }

  /** 테스트봇 전복(ERROR) 시뮬레이션 토글 — 체크 시 IMU roll 90° 자세 주입 → 백엔드 전복 감지로 ERROR.
   *  해제 시 정상 자세 IMU 1회 주입 → ERROR→IDLE 복구. @returns 성공 여부 */
  setError(robotId: string, on: boolean): boolean {
    const bot = this.bots.get(robotId);
    if (!bot) return false;
    bot.error = on;
    if (on) { bot.moving = false; bot.goal = null; } // 전복 시 정지
    this.emitOne(robotId, bot, Date.now()); // 즉시 반영(전복 ON이면 기운 IMU 포함)
    // 해제 시: 정상 자세 IMU 1회 주입 → onImu가 ERROR→IDLE 복구
    if (!on) {
      this.rosService.injectMessage({ topic: `/${robotId}/imu`, data: { orientation: { x: 0, y: 0, z: 0, w: 1 } }, timestamp: Date.now() });
    }
    this.logger.log(`${robotId} 전복(ERROR) 시뮬레이션 → ${on ? 'ON' : 'OFF'}`);
    return true;
  }

  /** 테스트봇 적재(SUPPLY 비전 적재 완료) 신호 1회 주입 — /omx/vision/is_loaded=true 발행 → 대기 중 SUPPLY COMPLETED.
   *  is_loaded 는 로봇별이 아니라 단일 비전 허브 토픽이라(omx 1대 전제), 진행 중인 SUPPLY 1건을 완료시킨다.
   *  vision 신호는 1회 소비되므로 지속 상태가 아니라 누를 때마다 1회 발행한다(적재 대기 중일 때 눌러야 효과). @returns 성공 여부 */
  signalLoaded(robotId: string): boolean {
    const bot = this.bots.get(robotId);
    if (!bot) return false;
    this.rosService.injectMessage({ topic: LOADED_TOPIC, data: { data: true }, timestamp: Date.now() });
    this.logger.log(`${robotId} 적재 신호 주입 → ${LOADED_TOPIC}=true (대기 중 SUPPLY 완료)`);
    return true;
  }

  /** 시뮬레이터 내부 위치를 직접 지정(+즉시 텔레메트리 반영). 백엔드 재시작 시 lastNode 좌표 복원 등에 사용. */
  setPose(robotId: string, x: number, y: number, yaw: number): boolean {
    const bot = this.bots.get(robotId);
    if (!bot) return false;
    bot.pose = { x, y, yaw };
    bot.goal = null;
    bot.moving = false;
    this.emitOne(robotId, bot, Date.now());
    this.logger.log(`${robotId} 시작 위치 설정 → (${x.toFixed(2)}, ${y.toFixed(2)})`);
    return true;
  }

  /** 현재 테스트봇 배터리/전복 상태 목록 (UI 초기 표시용) */
  getBatteries(): { robotId: string; battery: number; error: boolean }[] {
    return [...this.bots.entries()].map(([robotId, b]) => ({ robotId, battery: Math.round(b.battery), error: b.error }));
  }

  // odom / amcl_pose / battery_state (+전복 시 imu) 한 대 분 주입
  private emitOne(id: string, bot: BotState, now: number) {
    if (bot.moving) bot.battery = Math.max(BAT_MIN, bot.battery - BAT_DRAIN); // 이동 중 소모 (정지 중엔 유지)
    this.rosService.injectMessage(this.poseMsg(id, bot, 'amcl_pose', now));
    this.rosService.injectMessage(this.poseMsg(id, bot, 'odom', now));
    this.rosService.injectMessage({
      topic: `/${id}/battery_state`,
      data: { percentage: bot.battery },
      timestamp: now,
    });
    // 전복 ON: roll 90° 자세 IMU 주입(매 하트비트) → onImu가 ERROR 전환·태스크 반납.
    // 전복 OFF: 정상 자세는 setError(false) 시 1회만 주입(복구), 평상시엔 imu 미주입(부하 절감).
    if (bot.error) {
      this.rosService.injectMessage({ topic: `/${id}/imu`, data: { orientation: { x: 0.7071, y: 0, z: 0, w: 0.7071 } }, timestamp: now });
    }
  }

  private poseMsg(id: string, bot: BotState, kind: 'amcl_pose' | 'odom', now: number): RosMessage {
    const { x, y, yaw } = bot.pose;
    return {
      topic: `/${id}/${kind}`,
      data: {
        pose: {
          pose: {
            position:    { x, y, z: 0 },
            orientation: Quaternion.fromYaw(yaw).toObject(),
          },
        },
      },
      timestamp: now,
    };
  }
}

