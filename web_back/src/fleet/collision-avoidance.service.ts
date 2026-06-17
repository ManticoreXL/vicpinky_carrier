import { Injectable, Logger } from '@nestjs/common';
import { TopologyService } from './topology.service';

// ── 상수 ─────────────────────────────────────────────────────────────────────

// 다른 로봇이 이 반경 안에서 목표 노드를 점유하면 충돌로 판정
const NODE_PASS_M = 1.5;

// ── 타입 ─────────────────────────────────────────────────────────────────────

/** 충돌 평가 입력 — 활성 로봇의 경로 + 현재 위치 */
export interface RobotPathState {
  robotId:   string;
  pathQueue: string[];
  posX:      number | null;
  posY:      number | null;
}

/** 충돌 평가 결과 — 호출자(TaskManager)가 실제 정지/재출발을 수행 */
export interface CollisionDecision {
  robotId:       string;
  action:        'stop' | 'resume';
  conflictNode?: string; // stop: 점유된 노드
  blockerId?:    string; // stop: 점유 중인 로봇
}

// ── 서비스 ────────────────────────────────────────────────────────────────────
//
// "2-ahead 노드 예약" 방식의 충돌 회피.
// 각 로봇의 2칸 앞 노드(pathQueue[1])에 다른 로봇이 NODE_PASS_M 안으로 들어와 있으면
// 그 로봇을 미리 정지시키고, 노드가 비워지면 재출발 결정을 반환한다.
//
// 부수효과(cmd_vel 정지 발행, goal 재전송)는 호출자에서 수행하고,
// 이 서비스는 "정지/재출발 결정"과 그 상태(stoppedForNode)만 책임진다 (순수 의사결정).

@Injectable()
export class CollisionAvoidanceService {
  private readonly logger = new Logger(CollisionAvoidanceService.name);

  // robotId → 점유 로봇 때문에 현재 정지 대기 중인 노드 ID
  private readonly stoppedForNode = new Map<string, string>();

  constructor(private readonly topologyService: TopologyService) {}

  // ── 상태 조회/정리 (TaskManager의 waypoint/cancel 로직에서 사용) ───────────

  /** 이 로봇이 충돌 회피로 정지 대기 중인가 */
  isWaiting(robotId: string): boolean {
    return this.stoppedForNode.has(robotId);
  }

  getBlockedNode(robotId: string): string | undefined {
    return this.stoppedForNode.get(robotId);
  }

  /** 태스크 취소/맵 변경/오프라인 등으로 로봇 상태를 강제 정리 */
  clear(robotId: string): void {
    this.stoppedForNode.delete(robotId);
  }

  // ── 충돌 평가 ─────────────────────────────────────────────────────────────
  //
  // 매 tick마다 활성 로봇 전체 상태를 받아 정지/재출발 결정 목록을 반환한다.

  async evaluate(robots: RobotPathState[]): Promise<CollisionDecision[]> {
    const decisions: CollisionDecision[] = [];

    // 평가 대상에 없는데(=태스크 종료) 여전히 정지 표시가 남은 로봇 정리
    const activeIds = new Set(robots.map(r => r.robotId));
    for (const id of [...this.stoppedForNode.keys()]) {
      if (!activeIds.has(id)) this.stoppedForNode.delete(id);
    }

    // 2-ahead 노드 좌표 일괄 조회 (중복 제거)
    const twoAheadIds = new Set<string>();
    for (const r of robots) {
      if (r.pathQueue.length >= 2) twoAheadIds.add(r.pathQueue[1]);
    }
    const nodePos = new Map<string, { x: number; y: number }>();
    await Promise.all(
      [...twoAheadIds].map(async (nodeId) => {
        const node = await this.topologyService.findNodeById(nodeId);
        if (node) nodePos.set(nodeId, { x: node.x, y: node.y });
      }),
    );

    for (const me of robots) {
      // 경로가 1칸 이하 남음 → 정지 해제 후 남은 노드로 재출발
      if (me.pathQueue.length < 2) {
        if (this.stoppedForNode.has(me.robotId)) {
          this.stoppedForNode.delete(me.robotId);
          if (me.pathQueue.length > 0) {
            decisions.push({ robotId: me.robotId, action: 'resume' });
          }
        }
        continue;
      }

      const twoAheadId   = me.pathQueue[1];
      const twoAheadNode = nodePos.get(twoAheadId);

      // 2칸 앞 노드를 점유 중인 다른 로봇 탐색
      let blockerId: string | null = null;
      if (twoAheadNode) {
        for (const other of robots) {
          if (other.robotId === me.robotId) continue;
          if (other.posX == null || other.posY == null) continue;
          const dist = Math.hypot(other.posX - twoAheadNode.x, other.posY - twoAheadNode.y);
          if (dist < NODE_PASS_M) { blockerId = other.robotId; break; }
        }
      }

      if (blockerId) {
        // 새로 막힌 경우에만 정지 결정 (중복 발행 방지)
        if (!this.stoppedForNode.has(me.robotId)) {
          this.stoppedForNode.set(me.robotId, twoAheadId);
          this.logger.log(`[충돌] ${me.robotId} 정지 — ${twoAheadId} 점유 중 (${blockerId})`);
          decisions.push({ robotId: me.robotId, action: 'stop', conflictNode: twoAheadId, blockerId });
        }
      } else if (this.stoppedForNode.get(me.robotId) === twoAheadId) {
        // 막았던 노드가 비워짐 → 재출발
        this.stoppedForNode.delete(me.robotId);
        this.logger.log(`[충돌] ${me.robotId} 재출발 — ${twoAheadId} 비워짐`);
        decisions.push({ robotId: me.robotId, action: 'resume' });
      }
    }

    return decisions;
  }
}
