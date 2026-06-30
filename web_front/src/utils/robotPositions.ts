// 로봇 위치 추출 — AMCL(맵 프레임) 우선 → odom 폴백. 지도 마커 표시용(ROS 데이터를 그대로 표시).
// 도메인 판정이 아니라 표시 헬퍼다. (이전 utils/robotScore.ts 에서 분리.)
import type { RosMessage } from "../hooks/useNestSocket";

export interface RobotPos { x: number; y: number; }

export function robotPositions(rosMessages: Record<string, RosMessage>, robotIds: readonly string[]): Record<string, RobotPos> {
  const result: Record<string, RobotPos> = {};
  for (const id of robotIds) {
    const amcl = (rosMessages[`/${id}/amcl_pose`]?.data as any)?.pose?.pose?.position;
    if (amcl?.x != null) { result[id] = { x: amcl.x, y: amcl.y }; continue; }
    const odom = (rosMessages[`/${id}/odom`]?.data as any)?.pose?.pose?.position;
    if (odom?.x != null) result[id] = { x: odom.x, y: odom.y };
  }
  return result;
}
