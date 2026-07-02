// TaskManagerService 타입

import type { AlertType } from '../fms-events/alert';

export interface TaskManagerAlert {
  id: string;
  type: AlertType;
  taskId?: string;
  robotId?: string;
  message: string;
  requiresAction: boolean;
  timestamp: number;
}

export interface RobotCache {
  lastSeen:       number;
  batteryPct:     number | null;
  charging?:      boolean | null; // battery_state power_supply_status === CHARGING(1). null = 미보고

  posX:           number | null;
  posY:           number | null;
  yaw:            number | null;
  lastAmclMs:     number | null; // amcl_pose 마지막 수신 시각
  amclSuspended?: boolean;       // AMCL 타임아웃으로 태스크 일시정지 중
}
