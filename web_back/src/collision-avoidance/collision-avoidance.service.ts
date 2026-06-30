import { Injectable, Logger } from '@nestjs/common';
import { TopologyService } from '../topology/topology.service';

// ── 상수 ─────────────────────────────────────────────────────────────────────

// 다른 로봇이 이 반경 안에서 목표 노드를 점유하면 충돌로 판정
const NODE_PASS_M = 1.5;

// ── 타입 ─────────────────────────────────────────────────────────────────────

/** 충돌 평가 입력 — 활성 로봇의 경로 + 현재 위치 + 양보 우선순위 */
export interface RobotPathState {
  robotId:   string;
  pathQueue: string[];
  posX:      number | null;
  posY:      number | null;
  priority:  number; // 양보 우선순위 (낮을수록 먼저). 호출자가 TYPE_PRIORITY 기반 trafficPriority로 채움
  order:     number; // TASK 받은 시각(ms). 우선순위 같을 때 이른 쪽이 먼저
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
// 우선순위 기반 양보 충돌 회피 (경로 계획은 점유를 무시하고, 충돌은 여기서 해결).
// 어떤 로봇 me 의 '다음 노드'(pathQueue[0])를 다른 로봇이 점유 중이거나 같은 노드를
// 노리고 있으면, 두 로봇의 우선순위(priority↑ → order↑ → robotId)를 비교해 **더 낮은
// 쪽만 양보(정지)**시킨다. 비교가 완전순서라 항상 한 쪽만 멈춰 정면 교착이 없다.
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

    // 각 로봇의 '다음 노드'(pathQueue[0]) 좌표 일괄 조회
    const nextIds = new Set<string>();
    for (const r of robots) if (r.pathQueue.length > 0) nextIds.add(r.pathQueue[0]);
    const nodePos = new Map<string, { x: number; y: number }>();
    await Promise.all(
      [...nextIds].map(async (nodeId) => {
        const node = await this.topologyService.findNodeById(nodeId);
        if (node) nodePos.set(nodeId, { x: node.x, y: node.y });
      }),
    );

    // 완전순서: 우선순위(작을수록 먼저) → TASK 받은 시각(이를수록 먼저) → robotId
    const goesFirst = (a: RobotPathState, b: RobotPathState): boolean =>
      a.priority !== b.priority ? a.priority < b.priority
      : a.order !== b.order     ? a.order < b.order
      : a.robotId < b.robotId;

    for (const me of robots) {
      if (me.pathQueue.length === 0) {
        this.stoppedForNode.delete(me.robotId); // 도착/경로없음 — 정지 표시 정리
        continue;
      }

      const nextId = me.pathQueue[0];
      const np     = nodePos.get(nextId);

      // 다음 노드를 점유 중이거나(근접) 같은 노드를 노리는 '더 우선'인 다른 로봇 탐색
      let blockerId: string | null = null;
      for (const other of robots) {
        if (other.robotId === me.robotId) continue;
        const nearMyNext = !!np && other.posX != null && other.posY != null
          && Math.hypot(other.posX - np.x, other.posY - np.y) < NODE_PASS_M;
        const sameTarget = other.pathQueue[0] === nextId;
        if (!nearMyNext && !sameTarget) continue;
        if (goesFirst(other, me)) { blockerId = other.robotId; break; } // 상대가 우선 → 내가 양보
      }

      if (blockerId) {
        if (this.stoppedForNode.get(me.robotId) !== nextId) {
          this.stoppedForNode.set(me.robotId, nextId);
          this.logger.log(`[충돌] ${me.robotId} 양보 정지 — ${nextId} (우선: ${blockerId})`);
          decisions.push({ robotId: me.robotId, action: 'stop', conflictNode: nextId, blockerId });
        }
      } else if (this.stoppedForNode.has(me.robotId)) {
        this.stoppedForNode.delete(me.robotId);
        this.logger.log(`[충돌] ${me.robotId} 재출발 — ${nextId} 우선권 확보`);
        decisions.push({ robotId: me.robotId, action: 'resume' });
      }
    }

    return decisions;
  }
}
