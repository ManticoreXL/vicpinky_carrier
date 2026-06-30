import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Server } from 'socket.io';
import { RosService } from '../ros/ros.service';
import { RobotService } from '../robot/robot.service';
import type { RosMessage } from '../ros/ros.types';
import { Quaternion } from '../geometry/pose';
import { normalizeBatteryPct } from '../common/battery';

// ── 상수 ─────────────────────────────────────────────────────────────────────

// 같은 로봇에 대한 DB write 최소 간격 — amcl_pose/odom는 초당 수십 Hz로 들어오므로
// throttle 없이 그대로 쓰면 MongoDB가 과부하된다.
const DB_WRITE_THROTTLE_MS = 1_000;
// 위치 변화가 이 값 미만이면 DB write 생략 (정지 중 불필요한 write 방지)
const POSE_EPSILON_M = 0.03;
// 배터리 변화가 이 값 이상이면 throttle 무시하고 즉시 반영
const BATTERY_FORCE_DELTA = 1.0;

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface RobotTelemetry {
  robotId: string;
  posX: number | null;
  posY: number | null;
  yaw: number | null;
  battery: number | null;
  lastSeen: number;
  source: 'amcl' | 'odom' | null; // 위치 출처 (amcl이 정확, odom은 근사)
}

// ── 서비스 ────────────────────────────────────────────────────────────────────
//
// ROS 토픽이 바뀔 때마다 로봇 상태를 메모리 캐시에 갱신하고,
// throttle 후 MongoDB(fleet_robots)에 즉시 반영한다.
// 프론트에는 robot_telemetry 이벤트로 실시간 브로드캐스트한다.
//
// TaskManager의 robotCache와는 독립적으로 동작한다 (관심사 분리):
//   - TaskManager.robotCache : 태스크 진행 로직 전용 (amclSuspended 등)
//   - TelemetryService        : DB 영속화 + 프론트 브로드캐스트 + LLM 조회용 단일 소스

@Injectable()
export class TelemetryService implements OnModuleInit {
  private readonly logger = new Logger(TelemetryService.name);
  private server: Server | null = null;

  // robotId → 최신 텔레메트리 (in-memory, 항상 최신)
  private readonly cache = new Map<string, RobotTelemetry>();
  // robotId → 마지막 DB write 시각
  private readonly lastDbWrite = new Map<string, number>();
  // robotId → DB에 마지막으로 기록한 값 (변화 감지용)
  private readonly lastDbValue = new Map<string, { x: number | null; y: number | null; battery: number | null }>();

  constructor(
    private readonly rosService:   RosService,
    private readonly robotService: RobotService,
  ) {}

  onModuleInit() {
    this.rosService.onMessage((msg) => this.handle(msg));
  }

  setServer(server: Server) {
    this.server = server;
  }

  // ── 조회 API (LLM / 충돌 회피 / 디버깅) ───────────────────────────────────

  getTelemetry(robotId: string): RobotTelemetry | undefined {
    return this.cache.get(robotId);
  }

  getAll(): RobotTelemetry[] {
    return [...this.cache.values()];
  }

  // ── 오프라인 시 호출되어 캐시를 비움 ──────────────────────────────────────────
  clearTelemetry(robotId: string): void {
    const prev = this.cache.get(robotId);
    if (prev) {
      this.cache.set(robotId, {
        ...prev,
        posX: null,
        posY: null,
        yaw: null,
        battery: null,
        source: null,
      });
      this.broadcast(robotId);
    }
  }

  // ── ROS 메시지 처리 ───────────────────────────────────────────────────────

  private handle(msg: RosMessage) {
    const now = Date.now();

    // /{robotId}/amcl_pose — map 프레임 정확 위치 (최우선)
    const amclMatch = msg.topic.match(/^\/([^/]+)\/amcl_pose$/);
    if (amclMatch) {
      const id   = amclMatch[1];
      const pose = (msg.data as any)?.pose?.pose;
      const pos  = pose?.position;
      if (pos?.x != null) {
        this.applyPose(id, pos.x, pos.y ?? 0, Quaternion.from(pose?.orientation).yaw, 'amcl', now);
      }
      return;
    }

    // /{robotId}/odom — amcl이 없을 때만 폴백으로 사용 (근사 위치)
    const odomMatch = msg.topic.match(/^\/([^/]+)\/odom$/);
    if (odomMatch) {
      const id   = odomMatch[1];
      const prev = this.cache.get(id);
      // amcl이 최근(3s) 들어왔으면 odom 무시
      if (prev?.source === 'amcl' && now - prev.lastSeen < 3_000) {
        this.touch(id, now);
        return;
      }
      const pose = (msg.data as any)?.pose?.pose;
      const pos  = pose?.position;
      if (pos?.x != null) {
        this.applyPose(id, pos.x, pos.y ?? 0, Quaternion.from(pose?.orientation).yaw, 'odom', now);
      }
      return;
    }

    // /{robotId}/battery_state
    const batMatch = msg.topic.match(/^\/([^/]+)\/battery_state$/);
    if (batMatch) {
      const id = batMatch[1];
      const pct = normalizeBatteryPct((msg.data as { percentage?: number })?.percentage);
      this.applyBattery(id, pct, now);
      return;
    }

    // 그 외 로봇 네임스페이스 토픽 — lastSeen만 갱신
    const botMatch = msg.topic.match(/^\/([^/]+)\//);
    if (botMatch) this.touch(botMatch[1], now);
  }

  // ── 캐시 갱신 + DB 반영 ────────────────────────────────────────────────────

  private applyPose(
    id: string, x: number, y: number, yaw: number,
    source: 'amcl' | 'odom', now: number,
  ) {
    const prev = this.cache.get(id);
    this.cache.set(id, {
      robotId: id,
      posX: x, posY: y, yaw,
      battery: prev?.battery ?? null,
      lastSeen: now,
      source,
    });
    this.broadcast(id);
    void this.maybePersist(id, now);
  }

  private applyBattery(id: string, pct: number | null, now: number) {
    const prev = this.cache.get(id);
    this.cache.set(id, {
      robotId: id,
      posX: prev?.posX ?? null,
      posY: prev?.posY ?? null,
      yaw:  prev?.yaw ?? null,
      battery: pct,
      lastSeen: now,
      source: prev?.source ?? null,
    });
    this.broadcast(id);
    // 배터리 급변(예: 충전/방전 이벤트)은 throttle 무시
    const lastBat = this.lastDbValue.get(id)?.battery ?? null;
    const force   = pct != null && lastBat != null && Math.abs(pct - lastBat) >= BATTERY_FORCE_DELTA;
    void this.maybePersist(id, now, force);
  }

  private touch(id: string, now: number) {
    const prev = this.cache.get(id);
    if (!prev) {
      this.cache.set(id, { robotId: id, posX: null, posY: null, yaw: null, battery: null, lastSeen: now, source: null });
    } else {
      prev.lastSeen = now;
    }
  }

  /**
   * throttle + 변화량 검사를 통과하면 MongoDB에 반영한다.
   * force=true 면 throttle을 무시한다 (배터리 급변 등).
   */
  private async maybePersist(id: string, now: number, force = false) {
    const tel  = this.cache.get(id);
    if (!tel) return;

    const lastWrite = this.lastDbWrite.get(id) ?? 0;
    if (!force && now - lastWrite < DB_WRITE_THROTTLE_MS) return;

    // 위치 변화량 검사 — 정지 중이면 write 생략 (배터리만 바뀌면 통과)
    const lastVal = this.lastDbValue.get(id);
    if (!force && lastVal && tel.posX != null && lastVal.x != null && tel.posY != null && lastVal.y != null) {
      const moved        = Math.hypot(tel.posX - lastVal.x, tel.posY - lastVal.y);
      const batteryGone  = (tel.battery ?? null) !== (lastVal.battery ?? null);
      if (moved < POSE_EPSILON_M && !batteryGone) {
        return;
      }
    }

    this.lastDbWrite.set(id, now);
    this.lastDbValue.set(id, { x: tel.posX, y: tel.posY, battery: tel.battery });

    try {
      await this.robotService.updateTelemetry(id, {
        pose_x:     tel.posX,
        pose_y:     tel.posY,
        yaw:        tel.yaw,
        battery:    tel.battery,
        lastSeenAt: new Date(now),
      });
    } catch (e) {
      this.logger.warn(`[telemetry] ${id} DB 반영 실패: ${String(e)}`);
    }
  }

  private broadcast(id: string) {
    const tel = this.cache.get(id);
    if (!tel || !this.server) return;
    this.server.emit('robot_telemetry', tel);
  }

}
