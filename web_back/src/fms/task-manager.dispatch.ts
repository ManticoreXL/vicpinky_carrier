// 디스패치 경로 해석 — TaskManagerService 에서 분리한 순수 로직.
//
// 배정된 로봇·태스크에 대해 출발 노드를 정하고 A* 경로(pathQueue)를 반환한다.
// 출발 노드 우선순위: robot.location(현재 맵의 유효 노드) → AMCL 최근접 노드.
// 목적지 노드 없음 / 경로 없음이면 waitReason·FAILED 처리 후 null 반환(=스킵).
//
// 서비스 인스턴스의 private 상태에 직접 의존하지 않도록, 필요한 협력자만 ctx로 받는다.
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { FmsService } from './fms.service';
import { TaskStatus, TaskDocument } from './task.schema';
import { RobotService } from '../fleet/robot.service';
import { TopologyService } from '../fleet/topology.service';
import { RobotDocument } from '../fleet/robot.schema';
import { RobotCache } from './task-manager.types';
import { TaskManagerAlert } from './task-manager.types';

export interface DispatchCtx {
  logger: Logger;
  fmsService: FmsService;
  robotService: RobotService;
  topologyService: TopologyService;
  robotCache: Map<string, RobotCache>;
  server: Server | null;
  emit: (alert: Omit<TaskManagerAlert, 'id' | 'timestamp'>) => void;
}

export async function resolveDispatchPath(
  ctx: DispatchCtx,
  robot: RobotDocument,
  task: TaskDocument,
  taskId: string,
): Promise<string[] | null> {
  const robotId = robot.robot_id;
  let pathQueue: string[] = [];

  // 목적지 노드 확인 (map_id 결정에 필요)
  // 타겟 노드를 아이디 중심으초 찾음
  const targetNode = await ctx.topologyService.findNodeById(task.targetNode);
  if (!targetNode) {
    ctx.logger.warn(`[dispatch] 목적지 노드 "${task.targetNode}"가 DB에 없음`);
    await ctx.fmsService.setWaitReason(taskId, `목적지 노드 없음: ${task.targetNode}`);
    await ctx.fmsService.setStatus(taskId, TaskStatus.FAILED, ctx.server!);
    return null;
  }
  // 타겟 노드의 map_id를 가져옴
  const myMapId = targetNode.map_id;

  // 출발 노드 결정: robot.location이 현재 맵의 실제 노드인지 검증
  
  let startNodeId: string | null = null;
  let startFromLocation = false;

  if (robot.location && robot.location !== task.targetNode) {
    const locNode = await ctx.topologyService.findNodeById(robot.location);
    if (locNode && locNode.map_id === myMapId) {
      startNodeId = robot.location;
      startFromLocation = true;
    }
  }

  // AMCL 캐시로 최근접 노드 탐색 (robot.location 무효 또는 null인 경우)
  const getAmclNode = async (): Promise<string | null> => {
    const cache2 = ctx.robotCache.get(robotId);
    if (cache2?.posX != null && cache2.posY != null) {
      return ctx.topologyService.findNearestNodeToPosition(cache2.posX, cache2.posY, myMapId);
    }
    return null;
  };

  if (!startNodeId) {
    const amclNode = await getAmclNode();
    if (amclNode) {
      startNodeId = amclNode;
      await ctx.robotService.updateLocation(robotId, amclNode);
    }
  }

  if (!startNodeId || startNodeId === task.targetNode) {
    // 출발 노드가 없거나 이미 목적지
    ctx.logger.log(`[dispatch] ${robotId} startNode=${startNodeId ?? 'null'} — 목적지 직행 [${task.targetNode}]`);
    pathQueue = [task.targetNode];
  } else {
    let rawPath = await ctx.topologyService.findPath(startNodeId, task.targetNode, myMapId);

    // location 노드로 경로 탐색 실패 시 AMCL 위치 기반으로 재시도
    if (rawPath.length === 0 && startFromLocation) {
      ctx.logger.warn(`[dispatch] location 노드 "${startNodeId}" 경로 없음 (엣지 없음?) — AMCL 위치 기반 재탐색`);
      const amclNode = await getAmclNode();
      if (amclNode && amclNode !== startNodeId) {
        const retryPath = await ctx.topologyService.findPath(amclNode, task.targetNode, myMapId);
        if (retryPath.length > 0) {
          ctx.logger.log(`[dispatch] AMCL 재탐색 성공: ${amclNode} → ${task.targetNode}`);
          startNodeId = amclNode;
          rawPath = retryPath;
          await ctx.robotService.updateLocation(robotId, amclNode);
        }
      }
    }

    if (rawPath.length === 0) {
      ctx.logger.warn(`[dispatch] 경로 없음: ${startNodeId} → ${task.targetNode} (${robotId})`);
      await ctx.fmsService.setWaitReason(taskId, `경로 없음: ${startNodeId} → ${task.targetNode}`);
      // 노드 폐쇄 등으로 수행 불가 → 수동제어 전환을 유도하는 알림 (requiresAction)
      ctx.emit({ type: 'no_path', taskId, robotId, message: `경로를 찾을 수 없음: ${startNodeId} → ${task.targetNode} — 수동제어가 필요합니다`, requiresAction: true });
      await ctx.fmsService.setStatus(taskId, TaskStatus.FAILED, ctx.server!);
      return null;
    }
    pathQueue = rawPath.slice(1);
    // 각 노드 타입 확인 (station 중간 경유 진단용)
    const nodeTypes = await Promise.all(
      rawPath.map(id => ctx.topologyService.findNodeById(id).then(n => n ? `${id}(${n.type})` : `${id}(?)`)),
    );
    ctx.logger.log(`[dispatch] ${robotId} 경로 확정: [${nodeTypes.join('→')}] queue=[${pathQueue.join('→')}]`);
  }

  return pathQueue;
}
