import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService, CreateTaskDto } from './fms.service';
import { TaskStatus } from './task.schema';
import { RobotService } from '../robot/robot.service';
import { RobotStatus } from '../robot/robot.schema';
import { TopologyService } from '../topology/topology.service';
import { PathfindingService } from '../pathfinding/pathfinding.service';
import { NodeOccupancyService } from '../node-occupancy/node-occupancy.service';
import { CollisionAvoidanceService } from '../collision-avoidance/collision-avoidance.service';
import { LOOP_MS } from '../fms-shared/task-manager.constants';
import { TaskManagerEventsService } from '../fms-events/task-manager-events.service';
import { Alert } from '../fms-events/alert';
import { RobotStateService } from '../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../fms-state/robot-task-queue.service';
import { RotationStateService } from '../fms-state/rotation-state.service';
import { GlobalTaskQueueService } from './queue/global-task-queue.service';
import { ChargingService } from './charging/charging.service';
import { NavGoalService } from './navigation/nav-goal.service';
import { NodeLockService } from './node-lock/node-lock.service';
import { NavRecoveryService } from './navigation/nav-recovery.service';
import { NavigationService } from './navigation/navigation.service';
import { DispatchService } from './dispatch/dispatch.service';
import { RobotMonitorService } from './monitor/robot-monitor.service';

/**
 * FMS 오케스트레이터(파사드).
 *
 * 실제 로직은 역할별 서비스로 분리되어 있다:
 *   - 글로벌 task queue   → GlobalTaskQueueService
 *   - 로봇별 task queue    → RobotTaskQueueService
 *   - 배차/태스크별 실행   → DispatchService + task-handlers/*
 *   - 경로 탐색            → PathfindingService
 *   - 경로 주행 실행       → NavigationService (+ NavGoalService)
 *   - AMCL 복구            → NavRecoveryService
 *   - 노드 잠금/우회       → NodeLockService
 *   - 전복 감지            → FallDetectionService
 *   - ROS 메시지 라우팅    → RobotTelemetryService
 *   - 온라인/오프라인      → RobotMonitorService
 *
 * 이 클래스는 (1) 외부(게이트웨이/컨트롤러/AI)용 공개 API와 (2) 주기 tick 루프만 담당한다.
 */
@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly fmsService:    FmsService,
    private readonly robotService:  RobotService,
    private readonly topology:      TopologyService,
    private readonly pathfinding:   PathfindingService,
    private readonly occupancy:     NodeOccupancyService,
    private readonly collision:     CollisionAvoidanceService,
    private readonly events:        TaskManagerEventsService,
    private readonly robotState:    RobotStateService,
    private readonly robotTasks:    RobotTaskQueueService,
    private readonly rotationState: RotationStateService,
    private readonly globalQueue:   GlobalTaskQueueService,
    private readonly charging:      ChargingService,
    private readonly navGoal:       NavGoalService,
    private readonly nodeLock:      NodeLockService,
    private readonly navRecovery:   NavRecoveryService,
    private readonly navigation:    NavigationService,
    private readonly dispatch:      DispatchService,
    private readonly monitor:       RobotMonitorService,
  ) {}

  // ── 라이프사이클 ───────────────────────────────────────────────────────────

  onModuleInit() {
    this.running = true;
    void this.tick();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  setServer(server: Server) {
    this.events.setServer(server);
    this.topology.setServer(server);
    this.occupancy.setServer(server);
  }

  // ── 메인 처리 루프 ─────────────────────────────────────────────────────────
  private async tick() {
    if (!this.running) return;
    try {
      await this.monitor.syncOnlineStatus();
      await this.navRecovery.checkAmclTimeout();
      await this.dispatch.process();
      await this.navigation.checkNodeConflicts();
    } catch (e) { this.logger.error('루프 오류', e); }
    this.loopTimer = setTimeout(() => void this.tick(), LOOP_MS);
  }

  // ── 외부 API: 태스크 큐 ────────────────────────────────────────────────────

  async enqueue(dto: CreateTaskDto) {
    return this.globalQueue.enqueue(dto);
  }

  /** 등록만 — DRAFT 상태로 생성 (자동 배차 안 함) */
  async register(dto: CreateTaskDto) {
    return this.globalQueue.register(dto);
  }

  /** 자동충전 — 프론트는 robotId만 보낸다. 충전소 선택/점유 검사/배차는 백엔드(ChargingService)가 수행. */
  async autoCharge(robotId: string) {
    return this.charging.autoCharge(robotId);
  }

  /** 충전소에 머무는 로봇 정보(id + 배터리) 조회 */
  async getChargerOccupants(mapId: string) {
    return this.charging.getChargerOccupantsInfo(mapId);
  }

  /** DRAFT 태스크를 배차 큐(PENDING)에 투입 → 다음 tick에서 자동 배정 */
  async releaseTask(taskId: string) {
    return this.globalQueue.release(taskId);
  }

  // ── 외부 API: 노드 잠금 ────────────────────────────────────────────────────

  getLockedNodeIds(): Promise<string[]> {
    return this.nodeLock.getLockedNodeIds();
  }

  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    return this.nodeLock.lockNode(nodeId, isLocked);
  }

  // ── 외부 API: 홈/알림 ──────────────────────────────────────────────────────

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.robotState.setHome(robotId, x, y, yaw);
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── 긴급 정지 (EXAONE 에이전트 / 관제) ─────────────────────────────────────
  // 활성 태스크가 있으면 취소(=정지+IDLE), 없으면 단순 cmd_vel 정지.
  async stopRobot(robotId: string): Promise<{ ok: boolean; message: string }> {
    const taskId = this.robotTasks.getActive(robotId);
    if (taskId) {
      await this.cancelTask(taskId);
      return { ok: true, message: `${robotId} 태스크 취소 및 정지 완료` };
    }
    this.navGoal.hardStop(robotId);
    this.collision.clear(robotId);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
    return { ok: true, message: `${robotId} 정지 완료 (진행 중 태스크 없음)` };
  }

  // ── 홈 복귀 (EXAONE 에이전트 / 관제) ───────────────────────────────────────
  returnHomeNow(robotId: string): { ok: boolean; message: string } {
    const home = this.robotState.getHome(robotId);
    if (!home) {
      return { ok: false, message: `${robotId} 홈 위치가 등록되지 않음 — 맵에서 홈을 먼저 지정하세요` };
    }
    this.navGoal.returnHome(robotId);
    return { ok: true, message: `${robotId} 홈 복귀 시작 (${home.x.toFixed(2)}, ${home.y.toFixed(2)})` };
  }

  // ── 태스크 취소 + 로봇 즉시 정지 ──────────────────────────────────────────
  async cancelTask(taskId: string): Promise<void> {
    if (!this.events.hasServer) return;
    const server = this.events.server!;

    const task = await this.fmsService.getTask(taskId);
    if (!task) return;
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) return;

    await this.nodeLock.lockNode(task.targetNode, false);
    const robotId  = task.assignedRobotId;
    const isActive = !!robotId && this.robotTasks.getActive(robotId) === taskId;

    if (robotId && isActive) {
      // 현재 위치를 새 goal로 덮어써서 nav2의 이전 goal을 즉시 무효화
      const cache = this.robotState.getCache(robotId);
      if (cache?.posX != null && cache.posY != null) {
        this.fmsService.publishGoal(robotId, cache.posX, cache.posY, cache.yaw ?? 0);
      }
      this.navGoal.hardStop(robotId); // cmd_vel=0 (nav2 반응 전 움직임 대비)

      this.robotTasks.clearActive(robotId);
      this.rotationState.clear(robotId);
      this.collision.clear(robotId);
      this.occupancy.release(robotId);
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

      this.events.emit(Alert.info(`${robotId} 태스크 취소 — 현재 위치에서 정지`, { taskId, robotId }));
      this.logger.log(`[취소] ${robotId} 정지 (task: ${taskId})`);
    }

    await this.fmsService.setStatus(taskId, TaskStatus.FAILED, server, { completedAt: new Date() });

    // 활성 로봇을 비웠다면 대기열의 다음 태스크 착수
    if (robotId && isActive) await this.dispatch.dispatchNext(robotId);
  }

  // ── 맵 전환 시 태스크·위치·캐시 초기화 ────────────────────────────────────
  // 맵이 바뀌면 기존 pathQueue는 구 맵 노드 ID이므로 무효 → 활성 태스크 취소 +
  // robot.location 초기화 + AMCL 위치 캐시 클리어.
  async handleMapChange(robotId: string): Promise<void> {
    const taskId = this.robotTasks.getActive(robotId);
    if (taskId) {
      this.robotTasks.clearActive(robotId);
      if (this.events.hasServer) {
        await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
      } else {
        await this.fmsService.setStatusDirect(taskId, TaskStatus.FAILED);
      }
      this.logger.log(`[맵변경] ${robotId} → 진행 태스크 취소 (${taskId})`);
    }

    await this.robotService.updateLocation(robotId, null);
    await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

    if (this.robotState.getCache(robotId)) {
      this.robotState.patchCache(robotId, { posX: null, posY: null, yaw: null });
    }

    this.rotationState.clear(robotId);
    this.collision.clear(robotId);
    this.occupancy.release(robotId);

    // 진행 중인 nav2 주행 중단 (맵 변경으로 이전 goal_pose 무효)
    this.fmsService.publishStop(robotId);
    this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
  }

  // ── 초기위치 설정 + robot.location 즉시 갱신 ───────────────────────────────
  // 프론트에서 우클릭 드래그로 초기위치를 잡으면 호출. AMCL에 pose를 보내고
  // 가장 가까운 노드를 찾아 robot.location을 업데이트한다.
  async setInitialPoseAndLocation(
    robotId: string, x: number, y: number, yaw: number, mapId?: string,
  ): Promise<void> {
    this.fmsService.publishInitialPose(robotId, x, y, yaw);

    const nearestId = await this.pathfinding.findNearestNodeToPosition(x, y, mapId);
    if (nearestId) {
      await this.robotService.updateLocation(robotId, nearestId);
      this.logger.log(`[초기위치] ${robotId} location → ${nearestId} (${x.toFixed(2)}, ${y.toFixed(2)}) [map=${mapId ?? 'any'}]`);
    } else {
      this.logger.warn(`[초기위치] ${robotId} — 가까운 노드 없음 (map=${mapId ?? 'any'}, x=${x.toFixed(2)}, y=${y.toFixed(2)})`);
    }
  }
}
