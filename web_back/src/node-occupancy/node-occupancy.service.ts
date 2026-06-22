import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * 어느 로봇이 어느 노드를 점유 중인지 인메모리로 추적한다.
 * - robotToNode: robotId → 현재 점유 nodeId
 * - nodeToRobot: nodeId  → 현재 점유 robotId  (역방향 조회)
 *
 * occupy() 호출 시 이전 노드는 자동 해제된다.
 * 점유 변경마다 소켓 이벤트 'node_occupancy_changed' 를 발행한다.
 */
@Injectable()
export class NodeOccupancyService {
  private readonly logger = new Logger(NodeOccupancyService.name);
  private server: Server | null = null;

  private readonly robotToNode = new Map<string, string>();
  private readonly nodeToRobot = new Map<string, string>();

  setServer(server: Server) { this.server = server; }

  // ── 점유 등록 ────────────────────────────────────────────────────────────

  occupy(robotId: string, nodeId: string): void {
    const prev = this.robotToNode.get(robotId);
    if (prev === nodeId) return;

    // 이전 노드 해제
    if (prev) {
      this.nodeToRobot.delete(prev);
      this.server?.emit('node_occupancy_changed', { node_id: prev, robotId: null });
    }

    // 해당 노드를 이미 다른 로봇이 점유 중이면 그 로봇 기록 제거 (비정상 상황 방어)
    const existing = this.nodeToRobot.get(nodeId);
    if (existing && existing !== robotId) {
      this.robotToNode.delete(existing);
      this.logger.warn(`[점유] ${nodeId} 충돌 — 기존 점유(${existing}) 제거 후 ${robotId} 등록`);
    }

    this.robotToNode.set(robotId, nodeId);
    this.nodeToRobot.set(nodeId, robotId);
    this.server?.emit('node_occupancy_changed', { node_id: nodeId, robotId });
    this.logger.log(`[점유] ${robotId} → ${nodeId}`);
  }

  // ── 점유 해제 ────────────────────────────────────────────────────────────

  release(robotId: string): void {
    const nodeId = this.robotToNode.get(robotId);
    if (!nodeId) return;

    this.robotToNode.delete(robotId);
    this.nodeToRobot.delete(nodeId);
    this.server?.emit('node_occupancy_changed', { node_id: nodeId, robotId: null });
    this.logger.log(`[점유해제] ${robotId} ← ${nodeId}`);
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  /** 해당 노드를 점유 중인 robotId (없으면 undefined) */
  getOccupant(nodeId: string): string | undefined {
    return this.nodeToRobot.get(nodeId);
  }

  /** 해당 로봇이 점유 중인 nodeId (없으면 undefined) */
  getOccupiedNode(robotId: string): string | undefined {
    return this.robotToNode.get(robotId);
  }

  isOccupied(nodeId: string): boolean {
    return this.nodeToRobot.has(nodeId);
  }

  /** 경로 탐색에서 제외할 점유 노드 Set 반환 */
  getOccupiedNodeIds(): Set<string> {
    return new Set(this.nodeToRobot.keys());
  }

  /** 현재 전체 점유 현황 스냅샷 (nodeId → robotId) */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.nodeToRobot);
  }
}
