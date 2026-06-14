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
const OFFLINE_AFTER_MS = 10_000;
const BATTERY_MIN_PCT  = 20;
const GOAL_ARRIVE_M    = 0.35;

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

  // ── Waypoint 도착 감지 ────────────────────────────────────────────────────

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

    const nextNodeId = remaining[0];
    let targetX: number, targetY: number, targetYaw: number;
    let isVirtual = false;

    if (nextNodeId.startsWith('coord:')) {
      const parts = nextNodeId.split(':');
      targetX   = parseFloat(parts[1]);
      targetY   = parseFloat(parts[2]);
      targetYaw = parseFloat(parts[3]);
      isVirtual = true;
    } else {
      const node = await this.topologyService.findNodeById(nextNodeId);
      if (!node) return;
      targetX = node.x; targetY = node.y; targetYaw = node.yaw;
    }

    if (Math.hypot(x - targetX, y - targetY) > GOAL_ARRIVE_M) return;

    // 실제 노드 도착 시 위치 갱신 + 점유 엣지 업데이트
    if (!isVirtual) {
      const prevLoc = (await this.robotService.findById(robotId))?.location;
      await this.robotService.updateLocation(robotId, nextNodeId);

      // 이전 엣지 해제 후 다음 실제 노드 간 엣지 점유
      const nextActual = remaining.slice(1).find(id => !id.startsWith('coord:'));
      if (nextActual) {
        const node = await this.topologyService.findNodeById(nextNodeId);
        this.occupiedEdges.set(robotId, {
          from: nextNodeId, to: nextActual, mapId: node?.map_id ?? '',
        });
        this.logger.debug(`[점유] ${robotId}: ${nextNodeId}→${nextActual}`);
      } else {
        this.occupiedEdges.delete(robotId);
      }

      // 점유 상태 브로드캐스트 (프론트 시각화용)
      this.broadcastOccupiedEdges();

      void prevLoc; // suppress unused variable warning
    }

    remaining.shift();

    if (remaining.length > 0) {
      await this.fmsService.updatePathQueue(taskId, remaining, this.server);
      const nextId = remaining[0];
      let nx: number, ny: number, nyaw: number;
      if (nextId.startsWith('coord:')) {
        const parts = nextId.split(':');
        nx = parseFloat(parts[1]); ny = parseFloat(parts[2]); nyaw = parseFloat(parts[3]);
      } else {
        const nextNode = await this.topologyService.findNodeById(nextId);
        if (!nextNode) return;
        nx = nextNode.x; ny = nextNode.y; nyaw = nextNode.yaw;
      }
      this.fmsService.publishGoal(robotId, nx, ny, nyaw);
      this.emit({ type: 'info', taskId, robotId, message: `${robotId} → ${nextId} 이동 중`, requiresAction: false });
    } else {
      // 최종 목적지 도착
      this.activeTasks.delete(robotId);
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
    }
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
        if (wasOnline === false) {
          this.logger.log(`[온라인] ${robotId} 복귀`);
          this.emit({ type: 'info', robotId, message: `${robotId} 온라인 복귀`, requiresAction: false });
          this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
        } else {
          this.logger.log(`[온라인] ${robotId} 최초 감지`);
          this.server?.emit('robot_status_changed', { robot_id: robotId, status: 'IDLE' });
        }
      } else if (!isNowOnline && wasOnline !== false) {
        this.robotOnlineState.set(robotId, false);
        await this.robotService.setOfflineIfIdle(robotId);
        this.logger.warn(`[오프라인] ${robotId}`);
        this.emit({ type: 'robot_offline', robotId, message: `${robotId} 오프라인`, requiresAction: true });
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
      const robot   = freeRobots.shift()!;
      const robotId = robot.robot_id;
      const taskId  = (task._id as { toString(): string }).toString();

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

      } else {
        pathQueue = [task.targetNode];
      }

      // ── 태스크 할당 + 첫 엣지 점유 등록 ──────────────────────────────────
      this.activeTasks.set(robotId, taskId);

      // 첫 번째 실제 노드 간 엣지 점유
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

      // 첫 waypoint로 이동 시작
      const firstId = pathQueue[0];
      let firstX: number, firstY: number, firstYaw: number;
      if (firstId?.startsWith('coord:')) {
        const parts = firstId.split(':');
        firstX = parseFloat(parts[1]); firstY = parseFloat(parts[2]); firstYaw = parseFloat(parts[3]);
      } else if (firstId) {
        const firstNode = await this.topologyService.findNodeById(firstId);
        firstX = firstNode?.x ?? 0; firstY = firstNode?.y ?? 0; firstYaw = firstNode?.yaw ?? 0;
      } else {
        firstX = 0; firstY = 0; firstYaw = 0;
      }
      this.fmsService.publishGoal(robotId, firstX, firstY, firstYaw);

      this.emit({
        type: 'assigned', taskId, robotId,
        message: `${robotId} → [${task.type}] P${task.priority} (${task.targetNode}) 할당`,
        requiresAction: false,
      });
    }
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
