import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { TaskManagerAlert } from '../fms-shared/task-manager.types';
import { Alert } from './alert';

/**
 * Socket.io 서버 핸들 + 관제 알림(emit) 단일 소유자.
 *
 * 과거 TaskManagerService가 `server`를 직접 들고 모든 곳에서 `this.server?.emit(...)`
 * 하던 것을, 이 leaf 서비스로 모아 하위 서비스들이 공유한다. (다른 fms 서비스에
 * 의존하지 않으므로 순환 의존 위험이 없다)
 */
@Injectable()
export class TaskManagerEventsService {
  private readonly logger = new Logger('TaskManager');
  private _server: Server | null = null;

  setServer(server: Server) { this._server = server; }
  get server(): Server | null { return this._server; }
  get hasServer(): boolean { return this._server != null; }

  /** 임의의 소켓 이벤트 브로드캐스트 (robot_status_changed 등) */
  broadcast(event: string, payload: unknown): void {
    this._server?.emit(event, payload);
  }

  /** 관제 알림 발행 — id/timestamp 자동 부여 후 task_manager_alert 로 브로드캐스트 */
  emit(alert: Alert): void {
    if (!this._server) return;
    const full: TaskManagerAlert = {
      type:           alert.type,
      message:        alert.message,
      requiresAction: alert.requiresAction,
      taskId:         alert.taskId,
      robotId:        alert.robotId,
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this._server.emit('task_manager_alert', full);
    this.logger.log(`[TM] ${full.message}`);
  }
}
