import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService } from './fms.service';
import { TaskStatus } from './task.schema';
import { RosService } from '../ros/ros.service';
import { RobotService } from '../fleet/robot.service';
import { TopologyService } from '../fleet/topology.service';
import { RobotDocument, RobotStatus } from '../fleet/robot.schema';
import type { RosMessage } from '../ros/ros.types';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const LOOP_MS          = 2_000;
const ONLINE_MS        = 5_000;
const OFFLINE_AFTER_MS = 30_000;
const BATTERY_MIN_PCT  = 20;

// 위치 감지 반경
const COORD_PASS_M  = 0.8;  // 가상 coord 통과 감지 (빠른 반응)
const NODE_PASS_M   = 1.5;  // 중간 노드 통과 감지 (navigate_through_poses 진행 중 위치 추적용)
const NODE_ARRIVE_M = 0.5;  // 최종 목적지 도착 감지 (action result 백업)

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface TaskManagerAlert {
  id: string;
  type: 'battery' | 'robot_offline' | 'task_failed' | 'assigned' | 'completed' | 'info';
  taskId?: string;
  robotId?: string;
  message: string;
  requiresAction: boolean;
  timestamp: number;
}

interface RobotCache {
  lastSeen:   number;
  batteryPct: number | null;
  posX:       number | null;
  posY:       number | null;
  yaw:        number | null;
}

// 로봇이 현재 통과 중인 엣지 정보
interface OccupiedEdge {
  from:  string;
  to:    string;
  mapId: string;
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class TaskManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskManagerService.name);
  private server: Server | null = null;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;

  // robotId → 현재 활성 taskId
  private readonly activeTasks      = new Map<string, string>();
  // robotId → navigate_through_poses action goal ID (취소용)
  private readonly navGoalIds       = new Map<string, string>();
  // robotId → 현재 통과 중인 엣지 (점유 추적)
  private readonly occupiedEdges    = new Map<string, OccupiedEdge>();
  // robotId → 홈 위치
  private readonly homePositions    = new Map<string, { x: number; y: number; yaw: number }>();
  // robotId → ROS 상태 캐시
  private readonly robotCache       = new Map<string, RobotCache>();
  // 배터리 알림 중복 방지
  private readonly lastBatteryAlert = new Map<string, number>();
  // robotId → 온라인 여부 (undefined = 미확인)
  private readonly robotOnlineState = new Map<string, boolean>();

  constructor(
    private readonly fmsService:      FmsService,
    private readonly rosService:      RosService,
    private readonly robotService:    RobotService,
    private readonly topologyService: TopologyService,
  ) {}

  // ── 라이프사이클 ─────────────────────────────────────────────────────────

  onModuleInit() {
    this.rosService.onMessage((msg) => this.handleRosMessage(msg));
    this.running = true;
    void this.tick();
    this.logger.log('TaskManager 시작');
  }

  onModuleDestroy() {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  setServer(server: Server) { this.server = server; }

  // ── 외부 API ─────────────────────────────────────────────────────────────

  async enqueue(dto: Parameters<FmsService['createQueued']>[0]) {
    const task = await this.fmsService.createQueued(dto);
    this.server?.emit('fms_task_created', task);
    return task;
  }

  setHomePosition(robotId: string, x: number, y: number, yaw: number) {
    this.homePositions.set(robotId, { x, y, yaw });
    this.logger.log(`홈 설정: ${robotId} (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  ackAlert(_alertId: string) { /* 클라이언트 UI용 */ }

  // ── 태스크 취소 + 로봇 즉시 정지 ────────────────────────────────────────
  //
  // fmsService.cancel()은 상태만 변경하므로, 로봇 정지는 여기서 처리한다.

  async cancelTask(taskId: string): Promise<void> {
    if (!this.server) return;

    const task = await this.fmsService.getTask(taskId);
    if (!task) return;
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) return;

    const robotId = task.assignedRobot?.robot_id;

    if (robotId) {
      // 1. Nav2 navigate_through_poses action 취소 (정식 취소 → 로봇이 즉시 감속/정지)
      const goalId = this.navGoalIds.get(robotId);
      if (goalId) {
        this.rosService.cancelActionGoal(`/${robotId}/navigate_through_poses`, goalId);
        this.navGoalIds.delete(robotId);
      }

      // 2. cmd_vel=0 (action 취소가 늦을 경우 백업)
      for (let i = 0; i < 3; i++) {
        this.fmsService.publishStop(robotId);
      }

      // 3. activeTasks / occupiedEdges 정리
      this.activeTasks.delete(robotId);
      this.occupiedEdges.delete(robotId);
      this.broadcastOccupiedEdges();

      // 3. 로봇 상태 IDLE 복귀
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);

      this.emit({
        type: 'info', taskId, robotId,
        message: `${robotId} 태스크 취소 — 현재 위치에서 정지`,
        requiresAction: false,
      });
      this.logger.log(`[취소] ${robotId} 정지 (task: ${taskId})`);
    }

    // 4. DB 상태 FAILED 처리
    await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, {
      completedAt: new Date(),
    });
  }

  // ── 노드 잠금 + 실시간 우회 재경로 ──────────────────────────────────────
  //
  // 노드를 잠그면 해당 노드를 경유 중인 모든 활성 로봇의 경로를 재계산한다.

  async getLockedNodeIds(): Promise<string[]> {
    return this.topologyService.getAllLockedNodeIds();
  }

  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    await this.topologyService.setNodeLocked(nodeId, isLocked);
    if (!this.server) return;

    // 잠금 상태 브로드캐스트 (프론트 맵 시각화 즉시 업데이트)
    this.server.emit('node_lock_changed', { node_id: nodeId, isLocked });

    if (!isLocked) return; // 잠금 해제 시 재경로 불필요

    // 잠긴 노드를 경유하는 활성 태스크 로봇 재경로
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) continue;

      const pathQueue = task.pathQueue ?? [];
      if (!pathQueue.some(id => id === nodeId)) continue; // 이 노드 미포함

      this.logger.log(`[노드 폐쇄] ${robotId} 재경로 (차단 노드: ${nodeId})`);

      // 현재 위치 기반으로 출발 노드 결정
      const cache = this.robotCache.get(robotId);
      const robot = await this.robotService.findById(robotId);
      const targetNode = await this.topologyService.findNodeById(task.targetNode);
      if (!targetNode) continue;

      let startId: string | null = robot?.location ?? null;
      if (!startId && cache?.posX != null && cache.posY != null) {
        startId = await this.topologyService.findNearestNodeToPosition(
          cache.posX, cache.posY, targetNode.map_id,
        );
      }
      if (!startId || startId === task.targetNode) continue;

      // 잠긴 노드 회피 경로 탐색 (findPath 내부에서 lockedNodes 자동 반영)
      const newRaw = await this.topologyService.findPath(
        startId, task.targetNode, targetNode.map_id, this.getOccupiedEdgeKeys(robotId),
      );

      if (newRaw.length === 0) {
        this.logger.warn(`[노드 폐쇄] ${robotId}: 우회 경로 없음 — 대기`);
        await this.fmsService.setWaitReason(taskId, `노드 ${nodeId} 폐쇄로 우회 경로 없음`);
        // 현재 nav action 취소 (로봇 정지)
        const goalId = this.navGoalIds.get(robotId);
        if (goalId) {
          this.rosService.cancelActionGoal(`/${robotId}/navigate_through_poses`, goalId);
          this.navGoalIds.delete(robotId);
        }
        this.fmsService.publishStop(robotId);
        continue;
      }

      // 새 경로로 navigate_through_poses 재발행
      const newQueue = await this.interpolatePath(newRaw);
      if (newQueue.length > 0 && newQueue[0] === startId) newQueue.shift();

      // 기존 nav action 취소
      const oldGoalId = this.navGoalIds.get(robotId);
      if (oldGoalId) {
        this.rosService.cancelActionGoal(`/${robotId}/navigate_through_poses`, oldGoalId);
        this.navGoalIds.delete(robotId);
      }

      // DB pathQueue 업데이트 후 새 action 전송
      await this.fmsService.updatePathQueue(taskId, newQueue, this.server);

      const poses = await this.buildPoseList(newQueue);
      if (poses.length > 0) {
        const newGoalId = this.rosService.sendActionGoal(
          {
            actionName: `/${robotId}/navigate_through_poses`,
            actionType:  'nav2_msgs/action/NavigateThroughPoses',
            goal:        { poses, behavior_tree: '' },
          },
          undefined,
          (result) => { void this.handleNavResult(robotId, taskId, result.status); },
        );
        this.navGoalIds.set(robotId, newGoalId);
        this.logger.log(`[재경로] ${robotId}: ${newQueue.length} 포즈 (우회)`);
        this.emit({ type: 'info', taskId, robotId, message: `${robotId} 노드 ${nodeId} 우회 재경로`, requiresAction: false });
      }
    }
  }

  // ── 점유 엣지 헬퍼 ───────────────────────────────────────────────────────

  /** 현재 다른 로봇들이 점유한 엣지 키 집합을 반환 ("A→B" 형식) */
  private getOccupiedEdgeKeys(excludeRobotId: string): Set<string> {
    const keys = new Set<string>();
    for (const [rid, oe] of this.occupiedEdges) {
      if (rid === excludeRobotId) continue;
      keys.add(`${oe.from}→${oe.to}`);
      keys.add(`${oe.to}→${oe.from}`); // 반대 방향도 차단 (양방향 교차 방지)
    }
    return keys;
  }

  /** path에서 연속된 실제 노드 쌍으로 엣지 목록 추출 */
  private getNodeEdgesFromPath(pathQueue: string[]): { from: string; to: string }[] {
    const result: { from: string; to: string }[] = [];
    let prevActual: string | null = null;
    for (const id of pathQueue) {
      if (!id.startsWith('coord:')) {
        if (prevActual) result.push({ from: prevActual, to: id });
        prevActual = id;
      }
    }
    return result;
  }

  // ── ROS 메시지 처리 ─────────────────────────────────────────────────────

  private handleRosMessage(msg: RosMessage) {
    const now = Date.now();

    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch) {
      const id   = botMatch[1];
      const prev = this.robotCache.get(id) ?? { lastSeen: 0, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, lastSeen: now });
    }

    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id  = batMatch[1];
      let pct   = (msg.data as { percentage?: number })?.percentage ?? null;
      if (pct != null && pct <= 1.01) pct *= 100;
      const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null };
      this.robotCache.set(id, { ...prev, batteryPct: pct });
    }

    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id       = amclMatch[1];
      const poseData = (msg.data as { pose?: { pose?: { position?: { x?: number; y?: number }; orientation?: { x?: number; y?: number; z?: number; w?: number } } } })?.pose?.pose;
      const pos      = poseData?.position;
      const ori      = poseData?.orientation;
      if (pos?.x != null) {
        const prev = this.robotCache.get(id) ?? { lastSeen: now, batteryPct: null, posX: null, posY: null, yaw: null };
        let yaw = 0;
        if (ori) {
          yaw = Math.atan2(2 * ((ori.w ?? 1) * (ori.z ?? 0) + (ori.x ?? 0) * (ori.y ?? 0)), 1 - 2 * ((ori.y ?? 0) ** 2 + (ori.z ?? 0) ** 2));
        }
        this.robotCache.set(id, { ...prev, posX: pos.x, posY: pos.y ?? 0, yaw });
        void this.checkWaypointArrival(id, pos.x, pos.y ?? 0, yaw);
      }
    }
  }

  // ── 중간 웨이포인트 보간 ─────────────────────────────────────────────────
  // 노드 간 0.5m 간격의 좌표 웨이포인트를 삽입해 엣지를 정확히 따라가게 함

  private async interpolatePath(path: string[]): Promise<string[]> {
    const result: string[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const startId = path[i];
      const endId   = path[i + 1];
      const start   = await this.topologyService.findNodeById(startId);
      const end     = await this.topologyService.findNodeById(endId);
      if (!start || !end) { result.push(endId); continue; }

      const dx   = end.x - start.x;
      const dy   = end.y - start.y;
      const dist = Math.hypot(dx, dy);
      const yaw  = Math.atan2(dy, dx);
      const numPts = Math.max(0, Math.floor(dist / 0.5) - 1);

      for (let j = 1; j <= numPts; j++) {
        const t  = j / (numPts + 1);
        const rx = start.x + dx * t;
        const ry = start.y + dy * t;
        result.push(`coord:${rx.toFixed(3)}:${ry.toFixed(3)}:${yaw.toFixed(3)}`);
      }
      result.push(endId);
    }
    return result.length > 0 ? result : path.slice(1);
  }

  // ── 경유 노드 통과 감지 (위치 추적 전용) ────────────────────────────────
  //
  // navigate_through_poses action이 실제 경로 실행을 담당하므로,
  // 여기서는 next-goal 발행 없이 위치·점유·UI 진행만 업데이트한다.
  // 최종 목적지 완료는 handleNavResult가 처리 (이 함수는 백업으로도 동작).

  private async checkWaypointArrival(robotId: string, x: number, y: number, yaw: number) {
    const taskId = this.activeTasks.get(robotId);
    if (!taskId || !this.server) return;

    const task = await this.fmsService.getTask(taskId);
    if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      this.activeTasks.delete(robotId);
      this.occupiedEdges.delete(robotId);
      return;
    }

    const remaining = [...(task.pathQueue ?? [])];
    if (remaining.length === 0) return;

    const nextId = remaining[0];
    let targetX: number, targetY: number;
    let isVirtual = false;

    if (nextId.startsWith('coord:')) {
      const parts = nextId.split(':');
      targetX = parseFloat(parts[1]); targetY = parseFloat(parts[2]);
      isVirtual = true;
    } else {
      const node = await this.topologyService.findNodeById(nextId);
      if (!node) return;
      targetX = node.x; targetY = node.y;
    }

    // 통과 반경: 중간 coord=0.8m, 중간 노드=1.5m (navigate_through_poses 속도 유지),
    //            최종 노드=0.5m (action result 백업 완료 감지)
    const isFinal = !isVirtual && remaining.length === 1;
    const threshold = isVirtual ? COORD_PASS_M : (isFinal ? NODE_ARRIVE_M : NODE_PASS_M);

    if (Math.hypot(x - targetX, y - targetY) > threshold) return;

    if (!isVirtual) {
      // 실제 노드 통과/도착: 위치·점유 갱신
      await this.robotService.updateLocation(robotId, nextId);

      const nextActual = remaining.slice(1).find(id => !id.startsWith('coord:'));
      if (nextActual) {
        const node = await this.topologyService.findNodeById(nextId);
        this.occupiedEdges.set(robotId, { from: nextId, to: nextActual, mapId: node?.map_id ?? '' });
        this.logger.debug(`[통과] ${robotId}: ${nextId}→${nextActual}`);
      } else {
        this.occupiedEdges.delete(robotId);
      }
      this.broadcastOccupiedEdges();

      if (isFinal) {
        // 최종 목적지: action result 백업 완료 처리
        this.activeTasks.delete(robotId);
        this.navGoalIds.delete(robotId);
        this.occupiedEdges.delete(robotId);
        this.broadcastOccupiedEdges();

        await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
          completedAt: new Date(),
          assignedRobot: { robot_id: robotId, is_completed: true },
        });
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
        this.emit({ type: 'completed', taskId, robotId, message: `${robotId} 태스크 완료 (${task.targetNode})`, requiresAction: false });
        this.fmsService.publishInitialPose(robotId, x, y, yaw);
        this.returnHome(robotId);
        return;
      }
    }

    remaining.shift();
    await this.fmsService.updatePathQueue(taskId, remaining, this.server);
  }

  // ── 메인 처리 루프 ───────────────────────────────────────────────────────

  private async tick() {
    if (!this.running) return;
    try {
      await this.syncOnlineStatus();
      await this.process();
    } catch (e) { this.logger.error('루프 오류', e); }
    this.loopTimer = setTimeout(() => void this.tick(), LOOP_MS);
  }

  private async syncOnlineStatus() {
    const now = Date.now();
    for (const [robotId, cache] of this.robotCache.entries()) {
      const isNowOnline = now - cache.lastSeen < OFFLINE_AFTER_MS;
      const wasOnline   = this.robotOnlineState.get(robotId);

      if (isNowOnline && wasOnline !== true) {
        this.robotOnlineState.set(robotId, true);
        await this.robotService.bringOnlineIfOffline(robotId);
        // 실제 DB 상태를 읽어서 emit (hardcode IDLE 방지 → MOVING 중이면 MOVING 유지)
        const actualRobot = await this.robotService.findById(robotId);
        const actualStatus = actualRobot?.status ?? 'IDLE';
        if (wasOnline === false) {
          this.logger.log(`[온라인] ${robotId} 복귀 (상태: ${actualStatus})`);
          this.emit({ type: 'info', robotId, message: `${robotId} 온라인 복귀`, requiresAction: false });
        } else {
          this.logger.log(`[온라인] ${robotId} 최초 감지 (상태: ${actualStatus})`);
        }
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: actualStatus });

      } else if (!isNowOnline && wasOnline !== false) {
        this.robotOnlineState.set(robotId, false);

        // MOVING 상태에서 강제 종료 시에도 OFFLINE 처리 (기존 setOfflineIfIdle 대체)
        await this.robotService.setOffline(robotId);

        // 진행 중이던 태스크/nav action 정리
        const activeTaskId = this.activeTasks.get(robotId);
        if (activeTaskId) {
          const goalId = this.navGoalIds.get(robotId);
          if (goalId) {
            this.rosService.cancelActionGoal(`/${robotId}/navigate_through_poses`, goalId);
            this.navGoalIds.delete(robotId);
          }
          this.activeTasks.delete(robotId);
          this.occupiedEdges.delete(robotId);
          this.broadcastOccupiedEdges();
          // 태스크 FAILED 처리 (서버가 살아있는 경우)
          if (this.server) {
            await this.fmsService.setStatus(activeTaskId, TaskStatus.FAILED, this.server, {
              completedAt: new Date(),
            });
          }
        }

        this.logger.warn(`[오프라인] ${robotId}`);
        this.emit({ type: 'robot_offline', robotId, message: `${robotId} 오프라인 (태스크 중단)`, requiresAction: true });
        this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'OFFLINE' });
      }
    }
  }

  private async process() {
    if (!this.server) return;

    // 1. 완료/실패 태스크 → 로봇·엣지 해제
    for (const [robotId, taskId] of this.activeTasks) {
      const task = await this.fmsService.getTask(taskId);
      if (!task) { this.activeTasks.delete(robotId); this.occupiedEdges.delete(robotId); continue; }
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
        this.activeTasks.delete(robotId);
        this.occupiedEdges.delete(robotId);
        await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      }
    }

    // 2. PENDING 태스크 탐색
    const pending = await this.fmsService.getPendingTasks(20);
    if (!pending.length) return;

    // 3. 가용 IDLE 로봇
    const now2 = Date.now();
    const freeRobots: RobotDocument[] = [];
    for (const [robotId, cache] of this.robotCache.entries()) {
      if (now2 - cache.lastSeen >= ONLINE_MS) continue;
      if (this.activeTasks.has(robotId)) continue;
      const robot = await this.robotService.autoRegister(robotId);
      if (robot.status === RobotStatus.IDLE) freeRobots.push(robot);
    }
    if (!freeRobots.length) return;

    for (const task of pending) {
      if (!freeRobots.length) break;
      const taskId = (task._id as { toString(): string }).toString();

      // 지정 로봇이 있으면 그 로봇만 사용, 없으면 임의 배정
      let robot: RobotDocument;
      const preferredId = task.preferredRobotId;
      if (preferredId) {
        const idx = freeRobots.findIndex((r) => r.robot_id === preferredId);
        if (idx === -1) {
          await this.fmsService.setWaitReason(taskId, `지정 로봇 ${preferredId} 대기 중`);
          continue;
        }
        robot = freeRobots.splice(idx, 1)[0];
      } else {
        robot = freeRobots.shift()!;
      }

      const robotId = robot.robot_id;

      // 온라인 확인
      const cache  = this.robotCache.get(robotId);
      const online = cache && (Date.now() - cache.lastSeen) < ONLINE_MS;
      if (!online) {
        await this.fmsService.setWaitReason(taskId, '로봇 오프라인 — 재연결 대기');
        freeRobots.unshift(robot);
        continue;
      }

      // 배터리 확인
      const bat = cache?.batteryPct;
      if (bat != null && bat < BATTERY_MIN_PCT) {
        await this.fmsService.setWaitReason(taskId, `배터리 부족 (${bat.toFixed(0)}%)`);
        const lastAlert = this.lastBatteryAlert.get(robotId) ?? 0;
        if (Date.now() - lastAlert > 60_000) {
          this.lastBatteryAlert.set(robotId, Date.now());
          this.emit({ type: 'battery', taskId, robotId, message: `${robotId} 배터리 부족 (${bat.toFixed(0)}%)`, requiresAction: true });
        }
        freeRobots.unshift(robot);
        continue;
      }

      // ── 경로 탐색 ─────────────────────────────────────────────────────────
      let pathQueue: string[] = [];

      if (robot.location && robot.location !== task.targetNode) {
        const targetNode = await this.topologyService.findNodeById(task.targetNode);
        if (!targetNode) {
          await this.fmsService.setWaitReason(taskId, `목적지 노드 없음: ${task.targetNode}`);
          await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
          continue;
        }

        const myMapId = targetNode.map_id;

        // 1차 시도: 점유 엣지 회피 경로
        const blockedEdges = this.getOccupiedEdgeKeys(robotId);
        let rawPath = await this.topologyService.findPath(
          robot.location, task.targetNode, myMapId, blockedEdges,
        );

        if (rawPath.length === 0 && blockedEdges.size > 0) {
          // 2차 시도: 점유 무시 — 경로 자체는 존재하는지 확인
          const pathIgnoringOccupation = await this.topologyService.findPath(
            robot.location, task.targetNode, myMapId,
          );

          if (pathIgnoringOccupation.length > 0) {
            // 경로는 있지만 다른 로봇이 점유 중 → 가장 가까운 스테이션에서 대기
            const station = await this.topologyService.findNearestStation(robot.location, myMapId);
            const stationMsg = station ? ` → ${station} 대기` : '';
            await this.fmsService.setWaitReason(taskId, `엣지 점유 — 대기 중${stationMsg}`);
            this.emit({
              type: 'info', taskId, robotId,
              message: `${robotId}: 경로 점유 대기${stationMsg}`,
              requiresAction: false,
            });

            // 로봇이 이미 스테이션이 아닌 경우 스테이션으로 이동 명령 (goal만, 태스크 미생성)
            if (station && station !== robot.location) {
              const stPath = await this.topologyService.findPath(robot.location, station, myMapId, blockedEdges);
              if (stPath.length > 0) {
                const interpolated = await this.interpolatePath(stPath);
                const firstId = interpolated[0];
                if (firstId) {
                  let nx: number, ny: number, nyaw: number;
                  if (firstId.startsWith('coord:')) {
                    const p = firstId.split(':');
                    nx = parseFloat(p[1]); ny = parseFloat(p[2]); nyaw = parseFloat(p[3]);
                  } else {
                    const fn = await this.topologyService.findNodeById(firstId);
                    if (fn) { nx = fn.x; ny = fn.y; nyaw = fn.yaw; }
                    else     { nx = 0;   ny = 0;   nyaw = 0; }
                  }
                  this.fmsService.publishGoal(robotId, nx, ny, nyaw);
                  this.logger.log(`[대기 유도] ${robotId} → 스테이션 ${station}`);
                }
              }
            }
            freeRobots.unshift(robot);
            continue;
          } else {
            // 점유와 무관하게 경로 없음
            rawPath = [];
          }
        }

        if (rawPath.length === 0) {
          await this.fmsService.setWaitReason(taskId, `경로 없음: ${robot.location} → ${task.targetNode}`);
          this.emit({ type: 'task_failed', taskId, robotId, message: `경로를 찾을 수 없음: ${robot.location} → ${task.targetNode}`, requiresAction: false });
          await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server!);
          continue;
        }

        pathQueue = await this.interpolatePath(rawPath);
        if (pathQueue.length > 0 && pathQueue[0] === robot.location) pathQueue.shift();

      } else if (!robot.location) {
        // robot.location 없음 — 캐시된 AMCL 위치로 가장 가까운 노드를 출발점으로 탐색
        const cache2 = this.robotCache.get(robotId);
        const targetNode2 = await this.topologyService.findNodeById(task.targetNode);
        if (cache2?.posX != null && cache2.posY != null && targetNode2) {
          const nearestId = await this.topologyService.findNearestNodeToPosition(
            cache2.posX, cache2.posY, targetNode2.map_id,
          );
          if (nearestId && nearestId !== task.targetNode) {
            const rawPath2 = await this.topologyService.findPath(
              nearestId, task.targetNode, targetNode2.map_id, this.getOccupiedEdgeKeys(robotId),
            );
            if (rawPath2.length > 0) {
              pathQueue = await this.interpolatePath(rawPath2);
              // 이미 가장 가까운 노드 근처에 있으므로 출발 노드는 제거
              if (pathQueue.length > 0 && pathQueue[0] === nearestId) pathQueue.shift();
            }
          }
        }
        if (pathQueue.length === 0) pathQueue = [task.targetNode];
      } else {
        // robot.location === task.targetNode (이미 목적지)
        pathQueue = [task.targetNode];
      }

      // ── 태스크 할당 + 첫 엣지 점유 등록 ──────────────────────────────────
      this.activeTasks.set(robotId, taskId);

      const firstActual = pathQueue.find(id => !id.startsWith('coord:'));
      if (firstActual && robot.location) {
        const node = await this.topologyService.findNodeById(firstActual);
        this.occupiedEdges.set(robotId, {
          from: robot.location, to: firstActual, mapId: node?.map_id ?? '',
        });
        this.broadcastOccupiedEdges();
      }

      await this.fmsService.assignToRobot(taskId, robotId, pathQueue, this.server!);
      await this.robotService.updateStatus(robotId, RobotStatus.MOVING);

      // ── navigate_through_poses action 으로 전체 경로를 한 번에 전송 ──────
      // 중간 노드에서 속도를 줄이지 않고 최종 목적지에서만 정지
      const poses = await this.buildPoseList(pathQueue);
      if (poses.length > 0) {
        const goalId = this.rosService.sendActionGoal(
          {
            actionName: `/${robotId}/navigate_through_poses`,
            actionType:  'nav2_msgs/action/NavigateThroughPoses',
            goal:        { poses, behavior_tree: '' },
          },
          undefined,
          (result) => { void this.handleNavResult(robotId, taskId, result.status); },
        );
        this.navGoalIds.set(robotId, goalId);
        this.logger.log(`[navigate_through_poses] ${robotId}: ${poses.length} 포즈 전송`);
      } else {
        // 경로가 없으면 단순 goal_pose (목적지가 현재 위치와 같은 경우 등)
        const targetNode = await this.topologyService.findNodeById(task.targetNode);
        if (targetNode) {
          this.fmsService.publishGoal(robotId, targetNode.x, targetNode.y, targetNode.yaw);
        }
      }

      this.emit({
        type: 'assigned', taskId, robotId,
        message: `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당 (${poses.length} 포즈)`,
        requiresAction: false,
      });
    }
  }

  // ── navigate_through_poses 결과 처리 ────────────────────────────────────
  //
  // action result status:
  //   4 = SUCCEEDED, 5 = CANCELED (cancelTask에서 처리), 6 = ABORTED

  private async handleNavResult(robotId: string, taskId: string, status: number) {
    if (!this.server) return;

    const task = await this.fmsService.getTask(taskId);
    // 이미 취소/완료된 경우 무시
    if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      this.navGoalIds.delete(robotId);
      return;
    }

    this.navGoalIds.delete(robotId);

    if (status === 4) {
      // SUCCEEDED: 모든 포즈 완료
      await this.robotService.updateLocation(robotId, task.targetNode);
      this.activeTasks.delete(robotId);
      this.occupiedEdges.delete(robotId);
      this.broadcastOccupiedEdges();

      const cache = this.robotCache.get(robotId);
      const cx = cache?.posX ?? 0, cy = cache?.posY ?? 0, cyaw = cache?.yaw ?? 0;

      await this.fmsService.setStatus(taskId, TaskStatus.COMPLETED, this.server, {
        completedAt:   new Date(),
        assignedRobot: { robot_id: robotId, is_completed: true },
      });
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      this.emit({ type: 'completed', taskId, robotId, message: `${robotId} 태스크 완료 (${task.targetNode})`, requiresAction: false });
      this.fmsService.publishInitialPose(robotId, cx, cy, cyaw);
      this.returnHome(robotId);

    } else if (status === 6) {
      // ABORTED: Nav2 내부 실패
      this.activeTasks.delete(robotId);
      this.occupiedEdges.delete(robotId);
      this.broadcastOccupiedEdges();
      await this.robotService.updateStatus(robotId, RobotStatus.IDLE);
      await this.fmsService.setStatus(taskId, TaskStatus.FAILED, this.server, { completedAt: new Date() });
      this.emit({ type: 'task_failed', taskId, robotId, message: `${robotId} 내비게이션 실패 (ABORTED)`, requiresAction: false });
    }
    // status 5 (CANCELED) → cancelTask에서 이미 FAILED 처리
  }

  // ── navigate_through_poses용 포즈 목록 생성 ──────────────────────────────

  private async buildPoseList(pathQueue: string[]): Promise<Record<string, unknown>[]> {
    const now = Date.now() / 1000;
    const poses: Record<string, unknown>[] = [];

    for (const id of pathQueue) {
      let x: number, y: number, yaw: number;

      if (id.startsWith('coord:')) {
        const p = id.split(':');
        x = parseFloat(p[1]); y = parseFloat(p[2]); yaw = parseFloat(p[3]);
      } else {
        const node = await this.topologyService.findNodeById(id);
        if (!node) continue;
        x = node.x; y = node.y; yaw = node.yaw;
      }

      poses.push({
        header: { stamp: { sec: Math.floor(now), nanosec: 0 }, frame_id: 'map' },
        pose: {
          position:    { x, y, z: 0 },
          orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
        },
      });
    }

    return poses;
  }

  // ── 점유 상태 브로드캐스트 ───────────────────────────────────────────────

  private broadcastOccupiedEdges() {
    if (!this.server) return;
    const payload = Object.fromEntries(
      [...this.occupiedEdges.entries()].map(([rid, oe]) => [rid, oe]),
    );
    this.server.emit('occupied_edges', payload);
  }

  // ── 헬퍼 ─────────────────────────────────────────────────────────────────

  private returnHome(robotId: string) {
    const home = this.homePositions.get(robotId);
    if (!home) return;
    this.fmsService.publishGoal(robotId, home.x, home.y, home.yaw);
    this.emit({ type: 'info', robotId, message: `${robotId} 홈 복귀 중`, requiresAction: false });
  }

  private emit(alert: Omit<TaskManagerAlert, 'id' | 'timestamp'>) {
    if (!this.server) return;
    const full: TaskManagerAlert = {
      ...alert,
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.server.emit('task_manager_alert', full);
    this.logger.log(`[TM] ${full.message}`);
  }
}
