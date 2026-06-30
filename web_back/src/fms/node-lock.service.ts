import { Injectable } from '@nestjs/common';
import { TopologyService } from '../topology/topology.service';

/**
 * 노드 잠금·해제 — 사용자의 수동 폐쇄/해제 (표시 전용).
 *
 * DB 잠금(isLocked) + 소켓 브로드캐스트(node_lock_changed)는 TopologyService.setNodeLocked()가 수행한다.
 * 잠긴 노드는 다음 단일 명령의 경로계산(PathfindingService.findPath의 isLocked 회피)에서 자연히 회피된다.
 * (활성 로봇 자동 우회 재경로는 제거됨 — 수동 단일명령 모델)
 */
@Injectable()
export class NodeLockService {
  constructor(private readonly topology: TopologyService) {}

  /** 현재 잠긴 노드 ID 목록 */
  getLockedNodeIds(): Promise<string[]> {
    return this.topology.getAllLockedNodeIds();
  }

  /** 노드 잠금/해제 (DB + 브로드캐스트). 자동 우회 없음. */
  async lockNode(nodeId: string, isLocked: boolean): Promise<void> {
    await this.topology.setNodeLocked(nodeId, isLocked);
  }
}
