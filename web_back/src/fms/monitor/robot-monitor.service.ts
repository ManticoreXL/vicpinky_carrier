import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FmsService } from '../fms.service';
import { TaskStatus } from '../task.schema';
import { RobotService } from '../../robot/robot.service';
import { RobotStatus } from '../../robot/robot.schema';
import { TelemetryService } from '../../telemetry/telemetry.service';
import { NodeOccupancyService } from '../../node-occupancy/node-occupancy.service';
import { RobotStateService } from '../../fms-state/robot-state.service';
import { RobotTaskQueueService } from '../../fms-state/robot-task-queue.service';
import { GlobalTaskQueueService } from '../queue/global-task-queue.service';
import { TaskManagerEventsService } from '../../fms-events/task-manager-events.service';
import { Alert } from '../../fms-events/alert';
import { NodeLockService } from '../node-lock/node-lock.service';
import { OFFLINE_AFTER_MS } from '../../fms-shared/task-manager.constants';

/**
 * 로봇 온라인/오프라인 생명주기 감시.
 *
 * - 캐시 lastSeen 기반 온라인↔오프라인 전환 + 그에 따른 태스크/점유 정리
 * - 오프라인 로봇의 per-robot queue 대기 태스크는 글로벌 큐로 반환(재배차)
 * - DB 기준 오프라인 보정(서버 재시작/끊긴 로봇 정리)
 * - 서버 재시작 시 진행 중이던(메모리 잃은) 태스크 FAILED 복구
 */
@Injectable()
export class RobotMonitorService implements OnModuleInit {
  private readonly logger = new Logger(RobotMonitorService.name);
  private readonly startedAt = Date.now(); // 부팅 직후 첫 메시지 유예 시간 계산용

  constructor(
    private readonly fmsService:   FmsService,
    private readonly robotService: RobotService,
    private readonly telemetry:    TelemetryService,
    private readonly occupancy:    NodeOccupancyService,
    private readonly robotState:   RobotStateService,
    private readonly robotTasks:   RobotTaskQueueService,
    private readonly globalQueue:  GlobalTaskQueueService,
    private readonly events:       TaskManagerEventsService,
    private readonly nodeLock:     NodeLockService,
  ) {}

  onModuleInit() {
    void this.recoverActiveTasks();
  }

  // ── 서버 재시작 복구 ───────────────────────────────────────────────────────
  // activeTasks 메모리는 재시작 시 초기화되므로, DB의 진행 중 태스크를 FAILED 처리.
  private async recoverActiveTasks(): Promise<void> {
    try {
      const inProgress = await this.globalQueue.getInProgress();
      for (const task of inProgress) {
        const robotId = task.assignedRobotId;
        const taskId  = (task._id as { toString(): string }).toString();
        if (robotId && !this.robotTasks.hasActive(robotId)) {
          this.logger.warn(`[복구] 서버 재시작으로 인한 태스크 중단: ${taskId} (${robotId}) → FAILED`);
          await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
          if (this.events.hasServer) {
            await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
          } else {
            await this.fmsService.setStatusDirect(taskId, TaskStatus.FAILED);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`[복구] 태스크 복구 중 오류: ${String(e)}`);
    }
  }

  // ── 온라인/오프라인 전환 동기화 (매 tick) ──────────────────────────────────
  async syncOnlineStatus(): Promise<void> {
    const now = Date.now();
    for (const [robotId, cache] of [...this.robotState.entries()]) {
      const isNowOnline = now - cache.lastSeen < OFFLINE_AFTER_MS;
      const wasOnline   = this.robotState.getOnlineState(robotId);

      if (isNowOnline && wasOnline !== true) {
        this.robotState.setOnlineState(robotId, true);
        await this.robotService.bringOnlineIfOffline(robotId);
        const actualRobot  = await this.robotService.findById(robotId);
        const actualStatus = actualRobot?.status ?? 'IDLE';
        this.events.broadcast('robot_status_changed', { robot_id: robotId, status: actualStatus });
        // 신규 또는 복귀 로봇 전체 정보 브로드캐스트 (사이드바 즉시 반영)
        if (actualRobot) {
          this.events.broadcast('robot_registered', actualRobot.toObject ? actualRobot.toObject() : { ...actualRobot });
        }
      } else if (!isNowOnline && wasOnline !== false) {
        this.robotState.setOnlineState(robotId, false);

        // MOVING 상태에서 강제 종료 시에도 OFFLINE 처리
        await this.robotService.setOffline(robotId);
        this.telemetry.clearTelemetry(robotId);

        // 캐시 초기화 (배터리 및 위치 정보 날림)
        this.robotState.patchCache(robotId, { batteryPct: null, posX: null, posY: null, yaw: null });

        // 진행 중이던 태스크/nav action 정리
        const activeTaskId = this.robotTasks.getActive(robotId);
        if (activeTaskId) {
          this.robotTasks.clearActive(robotId);
          const task = await this.fmsService.getTask(activeTaskId);
          if (task) await this.nodeLock.lockNode(task.targetNode, false);
          if (this.events.hasServer) {
            await this.fmsService.setStatus(activeTaskId, TaskStatus.FAILED, this.events.server, { completedAt: new Date() });
          }
        }

        // per-robot 대기열의 태스크는 다른 로봇이 받도록 글로벌 큐로 반환
        for (const queuedId of this.robotTasks.drainQueue(robotId)) {
          await this.globalQueue.requeue(queuedId);
        }
        this.occupancy.release(robotId);

        this.events.emit(Alert.robotOffline(robotId, `${robotId} 오프라인 (태스크 중단)`));
        this.events.broadcast('robot_status_changed', { robot_id: robotId, status: 'OFFLINE' });
      }
    }

    // ── DB 기준 오프라인 보정 ────────────────────────────────────────────────
    // 위 캐시 루프는 "이번 세션에 메시지를 보낸" 로봇만 본다. 서버 재시작 후 꺼져 있던
    // 로봇이나 stray 메시지로 IDLE로 되돌아간 로봇은 캐시에 없어도 DB가 비-OFFLINE으로
    // 남아 IDLE에 갇힐 수 있어, DB를 직접 훑어 정리한다. (부팅 직후 유예시간 후 적용)
    if (now - this.startedAt > OFFLINE_AFTER_MS) {
      try {
        const notOffline = await this.robotService.findNotOffline();
        for (const r of notOffline) {
          const id    = r.robot_id;
          const cache = this.robotState.getCache(id);
          const live  = !!cache && (now - cache.lastSeen < OFFLINE_AFTER_MS);
          if (live) continue;                       // 실제 수신 중 → 캐시 루프가 관리
          if (this.robotTasks.hasActive(id)) continue; // 진행 태스크는 위 루프가 처리

          await this.robotService.setOffline(id);
          this.telemetry.clearTelemetry(id);
          this.robotState.setOnlineState(id, false);
          this.events.broadcast('robot_status_changed', { robot_id: id, status: 'OFFLINE' });
          this.logger.log(`[오프라인 보정] ${id} → OFFLINE (캐시 비활성 · DB ${r.status})`);
        }
      } catch (e) {
        this.logger.warn(`[오프라인 보정] 실패: ${String(e)}`);
      }
    }
  }
}
