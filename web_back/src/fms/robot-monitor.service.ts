import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import { TaskStatus } from './task.schema';
import { RobotService } from '../robot/robot.service';
import { RobotStatus } from '../robot/robot.schema';
import { TelemetryService } from '../telemetry/telemetry.service';
import { NodeOccupancyService } from '../node-occupancy/node-occupancy.service';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { NodeLockService } from './node-lock.service';
import { RosService } from '../ros/ros.service';
import type { RosMessage } from '../ros/ros.types';
import type { RobotCache } from '../fms-shared/task-manager.types';
import { TaskExecutionService } from './task-execution.service';
import { Quaternion } from '../geometry/pose';
import { OFFLINE_AFTER_MS, FALL_THRESH_RAD, CHARGE_TARGET_PCT, LOW_BATTERY_PCT } from '../fms-shared/task-manager.constants';
import { normalizeBatteryPct } from '../common/battery';

// 명령(다운링크) 토픽 — 로봇 생존 신호가 아님(프론트 명령 루프백 제외)
const COMMAND_TOPIC_RE = /\/(cmd_vel|goal_pose|initialpose|speak_cmd|joint_commands)$/;

/**
 * 로봇 모니터링 통합 (이전: RobotMonitorService + RobotTelemetryService + FallDetectionService).
 *
 *  - ROS 토픽 라우팅(onModuleInit): lastSeen / battery / amcl_pose→실행 도착판정 / imu→전복감지
 *  - 주기 동기화(syncOnlineStatus): 온/오프라인 전환·충전 표시·저배터리 알림
 */
@Injectable()
export class RobotMonitorService implements OnModuleInit {
  private readonly logger = new Logger(RobotMonitorService.name);
  // 저배터리 알림 1회 발생용 — robotId가 들어있으면 이미 알림함(배터리 회복/충전 시 해제)
  private readonly lowBatAlerted = new Set<string>();
  // 전복 알림 중복 방지 (30s 쿨다운)
  private readonly lastFallAlert = new Map<string, number>();

  constructor(
    private readonly taskRepo:     TaskRepositoryService,
    private readonly taskStatus:   TaskStatusService,
    private readonly robotService: RobotService,
    private readonly telemetry:    TelemetryService,
    private readonly occupancy:    NodeOccupancyService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly events:       TaskManagerEventsService,
    private readonly nodeLock:     NodeLockService,
    private readonly rosService:   RosService,
    private readonly exec:         TaskExecutionService,
  ) {}

  // ── ROS 토픽 → 로봇 상태 라우팅 ──────────────────────────────────────────────
  onModuleInit(): void {
    // 시작 스윕 — 모든 로봇 OFFLINE 리셋. 텔레메트리(online 판정)가 와야 다시 온라인+상태를 갖는다.
    // (재시작 전 stale online=true 가 그대로 남는 문제 방지)
    void this.robotService.markAllOffline().catch((e) => this.logger.error('[시작스윕] 오프라인 리셋 오류', e));
    this.rosService.onMessage((msg) => this.handle(msg));
  }

  private handle(msg: RosMessage): void {
    const now = Date.now();
    // 명령 토픽(cmd_vel 등)은 생존 신호 아님 → 온라인 판정 제외
    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch && !COMMAND_TOPIC_RE.test(msg.topic)) {
      this.robotState.patchCache(botMatch[1], { lastSeen: now }, now);
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const data = msg.data as { percentage?: number; power_supply_status?: number };
      const pct = normalizeBatteryPct(data?.percentage);
      const pss = data?.power_supply_status;
      const patch: Partial<RobotCache> = { batteryPct: pct };
      if (pss != null) patch.charging = pss === 1 || pss === 3 || pss === 4; // 2=DISCHARGING만 미충전
      this.robotState.patchCache(batMatch[1], patch, now);
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos = poseData?.position;
      if (pos?.x != null) {
        const yaw = poseData?.orientation ? Quaternion.from(poseData.orientation).yaw : 0;
        this.robotState.patchCache(id, { posX: pos.x, posY: pos.y ?? 0, yaw, lastAmclMs: now }, now);
        this.exec.onAmclPose(id, pos.x, pos.y ?? 0, yaw); // 주행 진행/도착 판정
      }
    }

    const imuMatch = msg.topic.match(/^\/([^/]+)\/imu$/);
    if (imuMatch) {
      const ori = (msg.data as { orientation?: { x?: number; y?: number; z?: number; w?: number } })?.orientation;
      if (ori) this.onImu(imuMatch[1], ori);
    }
  }

  // ── IMU 전복 감지 (roll/pitch > 45° → ERROR, 복귀 시 IDLE) ────────────────────
  private onImu(robotId: string, ori: { x?: number; y?: number; z?: number; w?: number }): void {
    const now = Date.now();
    const q = Quaternion.from(ori);
    if (Math.abs(q.roll) > FALL_THRESH_RAD || Math.abs(q.pitch) > FALL_THRESH_RAD) {
      // 에러 에피소드당 1회만 — 이미 알림했으면 복구(정상 자세 복귀) 전까진 다시 띄우지 않는다.
      if (this.lastFallAlert.has(robotId)) return;
      this.lastFallAlert.set(robotId, now);
      void this.robotService.updateStatus(robotId, RobotStatus.ERROR);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.ERROR });
      this.events.emit(Alert.fall(robotId, `${robotId} 전복 감지 — roll ${(q.roll * 180 / Math.PI).toFixed(0)}° / pitch ${(q.pitch * 180 / Math.PI).toFixed(0)}° → ERROR`));
      this.logger.warn(`[전복] ${robotId} ERROR 전환`);
      void this.handleErrorTransition(robotId); // 보유 태스크 글로벌 큐 반납(진행분은 FAILED+재등록)
      return;
    }
    void this.robotService.findById(robotId).then((robot) => {
      if (robot?.status !== RobotStatus.ERROR) return;
      void this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
      this.lastFallAlert.delete(robotId);
      this.logger.log(`[전복복구] ${robotId} 자세 복귀 → IDLE`);
    });
  }

  // ── 로봇 ERROR 전환 시 보유 태스크 글로벌 큐 반납 ────────────────────────────
  // 사용자가 다른 로봇을 다시 지정해 이어갈 수 있도록 모든 보유 태스크의 로봇 배정을 푼다.
  //  - 진행 중(RUNNING) 태스크: 그 기록은 FAILED 처리 + 같은 내용으로 새 PENDING 재등록
  //  - 그 외(PENDING/ASSIGNED): robot_id만 초기화해 그대로 글로벌 큐로 반납
  private async handleErrorTransition(robotId: string): Promise<void> {
    const { failed, returned, grouped } = await this.releaseRobotTasks(robotId, `로봇 ${robotId} ERROR — 실패 처리, 글로벌 큐에 새로 등록`);
    if (failed || returned || grouped) {
      this.events.emit(Alert.fall(robotId, `${robotId} ERROR — 진행 ${failed} 실패·재등록 / 대기 ${returned} 반납${grouped ? ` / 연속·시나리오 ${grouped} 실패` : ''}`));
    }
    this.logger.warn(`[ERROR] ${robotId} 태스크 정리 — 실패·재등록 ${failed} / 반납 ${returned} / 연속·시나리오 ${grouped}`);
  }

  /**
   * 로봇 보유 태스크 정리 (ERROR 전환 시 — handleErrorTransition 전용).
   *  - 진행 중(RUNNING) 태스크 → FAILED + 같은 내용으로 새 PENDING 재등록(미배정)
   *  - 예정(PENDING/ASSIGNED)  → robot_id만 초기화해 글로벌 큐로 반납
   *  + 진행 주행 즉시 정지(cmd_vel=0) + 노드 잠금/점유 해제.
   * @returns 처리 건수
   */
  async releaseRobotTasks(robotId: string, reason: string): Promise<{ failed: number; returned: number; grouped: number }> {
    if (!this.events.hasServer) return { failed: 0, returned: 0, grouped: 0 };
    const server = this.events.server!;
    this.robotTasks.clearActive(robotId);
    this.exec.hardStop(robotId);

    const tasks = await this.taskRepo.findReturnableByRobot(robotId); // PENDING/ASSIGNED/RUNNING
    const doneGroups = new Set<string>(); // 이미 묶어서 처리한 batchId/scenarioId
    let failed = 0, returned = 0, grouped = 0;

    for (const t of tasks) {
      await this.nodeLock.lockNode(t.targetNode, false);

      // 연속(batchId)·시나리오(scenarioId) 스텝이면 그룹 전체(미완료)를 한꺼번에 FAILED — 낱개로 흩어지지 않게.
      const field: 'batchId' | 'scenarioId' | null = t.batchId ? 'batchId' : t.scenarioId ? 'scenarioId' : null;
      const groupId = t.batchId ?? t.scenarioId ?? null;
      if (field && groupId) {
        if (doneGroups.has(groupId)) continue;
        doneGroups.add(groupId);
        const failed = await this.taskStatus.failGroupRemainder(field, groupId, `${reason} (${field === 'batchId' ? '연속' : '시나리오'} 전체 실패)`, server);
        for (const gt of failed) await this.nodeLock.lockNode(gt.targetNode, false);
        grouped += failed.length;
        continue;
      }

      // 단건: 진행 중(RUNNING) → FAILED + 글로벌 큐 반납(새 PENDING) / 예정(PENDING/ASSIGNED) → robot_id 초기화 반납
      if (t.status === TaskStatus.RUNNING) {
        await this.taskStatus.setStatus(String(t._id), TaskStatus.FAILED, server, { completedAt: new Date(), errorMessage: reason });
        await this.taskRepo.requeueFailedCopy(t); // 같은 내용의 새 PENDING(미배정) 재등록 + 브로드캐스트
        failed++;
      } else {
        await this.taskStatus.returnToQueue(String(t._id), server);
        returned++;
      }
    }
    this.occupancy.release(robotId);
    return { failed, returned, grouped };
  }

  // ── 온라인/오프라인 전환 동기화 (상태 표시) ──────────────────────────────────
  async syncOnlineStatus(): Promise<void> {
    const now = Date.now();
    for (const [robotId, cache] of [...this.robotState.entries()]) {
      const isNowOnline = now - cache.lastSeen < OFFLINE_AFTER_MS;
      const wasOnline   = this.robotState.getOnlineState(robotId);

      if (isNowOnline && wasOnline !== true) {
        await this.handleOnlineTransition(robotId);
      } else if (!isNowOnline && wasOnline !== false) {
        await this.handleOfflineTransition(robotId);
      }

      // 충전 상태는 battery_state 토픽값으로 표시 갱신 (진행 태스크 없을 때만)
      if (isNowOnline && !this.robotTasks.hasActive(robotId) && (cache.charging != null || cache.batteryPct != null)) {
        await this.reconcileChargingStatus(robotId, cache.charging, cache.batteryPct);
      }

      // 저배터리 알림 — 모든 로봇 동일(테스트봇 포함). 임계 이하로 떨어지면 1회 알림.
      if (isNowOnline) this.checkLowBattery(robotId, cache.batteryPct, cache.charging);
    }

    // ── DB 보정 스윕 — online=true 인데 캐시에 신선한 데이터가 없는 로봇은 OFFLINE 으로 정리 ──
    // 캐시에 한 번도 안 들어온(재시작 후 미접속)·데이터가 끊긴 로봇의 stale online 을 자동으로 끈다.
    // 캐시에 신선한 데이터가 있는 로봇은 위 루프가 이미 처리 → 여기선 가벼운 setOffline만(태스크/알림 정리 생략).
    for (const r of await this.robotService.findNotOffline()) {
      const cache = this.robotState.getCache(r.robot_id);
      if (cache && now - cache.lastSeen < OFFLINE_AFTER_MS) continue; // 신선 → 온라인 유지
      this.robotState.setOnlineState(r.robot_id, false);
      await this.robotService.setOffline(r.robot_id);
      this.events.broadcast('robot_status_changed', { robot_id: r.robot_id, status: RobotStatus.OFFLINE });
      this.logger.log(`[오프라인보정] ${r.robot_id} — 신선한 텔레메트리 없음 → OFFLINE`);
    }
  }

  /** 충전 필요(저배터리 알림 latched) 로봇인지 — 자동 충전 판단의 단일 출처. */
  needsCharge(robotId: string): boolean {
    if (!this.lowBatAlerted.has(robotId)) return false;
    // 방어적 해제: latch가 남아있어도 현재 배터리(텔레메트리)가 목표%(80%) 이상이면 즉시 "충전 필요" 해제.
    // → 동기화 틱의 checkLowBattery를 못 거친 경우에도 80%↑면 자동으로 충전 대기에서 빠져나오게 한다.
    const bat = this.robotState.getCache(robotId)?.batteryPct;
    if (bat != null && bat >= CHARGE_TARGET_PCT) {
      this.lowBatAlerted.delete(robotId);
      this.logger.log(`[충전필요해제] ${robotId} 배터리 ${Math.round(bat)}% ≥ ${CHARGE_TARGET_PCT}% → 충전 필요 해제`);
      return false;
    }
    return true;
  }

  // ── 저배터리 알림 (확인/자동충전) ────────────────────────────────────────────
  // 임계 이하 + 비충전이면 1회 알림. 배터리 회복(+5%)·충전 시 재무장하여 다음 저하 때 다시 알림.
  private checkLowBattery(robotId: string, batteryPct: number | null | undefined, charging: boolean | null | undefined): void {
    if (batteryPct == null) return;
    // 해제: 충전 완료(목표%↑)일 때만 "충전 필요"를 푼다 + "충전 완료" 알림 1회.
    // → 한번이라도 20% 미만이면, 실제로 충전될 때까지 "충전 필요" 유지(배터리가 잠깐 올라도 안 풀림).
    if (batteryPct >= CHARGE_TARGET_PCT) {
      if (this.lowBatAlerted.delete(robotId)) {
        this.events.emit(Alert.charged(robotId, `${robotId} 배터리 충전 완료 (${Math.round(batteryPct)}%)`));
        this.logger.log(`[충전완료] ${robotId} ${Math.round(batteryPct)}% → 충전 필요 해제`);
      }
      return;
    }
    if (charging === true) return;           // 이미 충전 중 → 새 알림 불필요(완료 시 위에서 해제)
    if (batteryPct >= LOW_BATTERY_PCT) return; // 20% 미만(strict)일 때만 알림
    if (this.lowBatAlerted.has(robotId)) return; // 이미 충전 필요 상태(중복 방지)
    this.lowBatAlerted.add(robotId);
    this.events.emit(Alert.lowBattery(robotId, `${robotId} 배터리 부족 (${Math.round(batteryPct)}%) — 충전이 필요합니다`));
    this.logger.log(`[저배터리] ${robotId} ${Math.round(batteryPct)}% < ${LOW_BATTERY_PCT}% → 충전 필요`);
  }

  // 오프라인→온라인: 상태/전체정보 브로드캐스트
  private async handleOnlineTransition(robotId: string): Promise<void> {
    this.robotState.setOnlineState(robotId, true);
    await this.robotService.bringOnlineIfOffline(robotId);
    const robot = await this.robotService.findById(robotId);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: robot?.status ?? 'IDLE' });
    if (robot) this.events.broadcast('robot_registered', robot.toObject ? robot.toObject() : { ...robot });
  }

  // 온라인→오프라인: OFFLINE 표시 + 텔레메트리/점유 정리 + 진행 태스크 FAILED 마킹 (재할당 없음)
  private async handleOfflineTransition(robotId: string): Promise<void> {
    this.robotState.setOnlineState(robotId, false);
    this.lowBatAlerted.delete(robotId); // 오프라인 → 저배터리 알림 재무장
    await this.robotService.setOffline(robotId);
    this.telemetry.clearTelemetry(robotId);
    this.robotState.patchCache(robotId, { batteryPct: null, posX: null, posY: null, yaw: null });

    // 진행 중이던 단일 태스크 정리 (FAILED 마킹 + 목적지 노드 잠금 해제)
    const activeTaskId = this.robotTasks.getActive(robotId);
    if (activeTaskId) {
      this.robotTasks.clearActive(robotId);
      const task = await this.taskRepo.getTask(activeTaskId);
      if (task) await this.nodeLock.lockNode(task.targetNode, false);
      if (this.events.hasServer) {
        await this.taskStatus.setStatus(activeTaskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
      }
    }
    this.occupancy.release(robotId);

    this.events.emit(Alert.robotOffline(robotId, `${robotId} 오프라인 (진행 태스크 중단)`));
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'OFFLINE' });
    this.logger.log(`[오프라인] ${robotId}`);
  }

  // ── 충전 상태 동기화 (battery_state power_supply_status 기준) ─────────────────
  private async reconcileChargingStatus(
    robotId: string, charging: boolean | null | undefined, batteryPct: number | null | undefined,
  ): Promise<void> {
    const robot = await this.robotService.findById(robotId);
    const status = robot?.status;
    // 충전 완료: 목표 배터리 도달 시 CHARGING→IDLE
    if (status === RobotStatus.CHARGING && batteryPct != null && batteryPct >= CHARGE_TARGET_PCT) {
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
      this.logger.log(`[충전완료] ${robotId} 배터리 ${batteryPct}% ≥ ${CHARGE_TARGET_PCT}% → IDLE`);
      return;
    }
    // 충전 대기(만석 대기) 중 배터리가 목표%까지 회복 → 대기(IDLE)로 복귀(충전 대기에서 자동 탈출)
    if (status === RobotStatus.WAITING_CHARGE && batteryPct != null && batteryPct >= CHARGE_TARGET_PCT) {
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
      this.logger.log(`[충전대기해제] ${robotId} 배터리 ${Math.round(batteryPct)}% ≥ ${CHARGE_TARGET_PCT}% → 대기(IDLE)`);
      return;
    }
    if (charging && status !== RobotStatus.CHARGING) {
      await this.robotService.updateStatus(robotId, RobotStatus.CHARGING);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.CHARGING });
    } else if (charging === false && status === RobotStatus.CHARGING) {
      // 명시적 방전(power_supply_status=2)일 때만 IDLE. charging=null(정보 없음)은 CHARGING 유지.
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.events.broadcast('robot_status_changed', { robot_id: robotId, status: RobotStatus.IDLE });
    }
  }
}
