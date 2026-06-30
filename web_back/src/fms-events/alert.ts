// 관제 알림 값 객체.
//
// 그동안 각 서비스가 `{ type:'info', taskId, robotId, message, requiresAction:false }`
// 같은 평문 리터럴을 13곳에 흩어 만들던 것을, 의미별 팩토리로 캡슐화한다.
// id/timestamp 부여 + 브로드캐스트는 TaskManagerEventsService가 담당한다.

export type AlertType =
  | 'fall' | 'robot_offline' | 'task_failed' | 'no_path' | 'assigned' | 'completed' | 'info' | 'low_battery' | 'charged';

export class Alert {
  private constructor(
    readonly type: AlertType,
    readonly message: string,
    readonly requiresAction: boolean,
    readonly taskId?: string,
    readonly robotId?: string,
  ) {}

  /** 일반 정보 알림 (관제 조치 불필요) */
  static info(message: string, ref: { taskId?: string; robotId?: string } = {}): Alert {
    return new Alert('info', message, false, ref.taskId, ref.robotId);
  }

  static assigned(taskId: string, robotId: string, message: string): Alert {
    return new Alert('assigned', message, false, taskId, robotId);
  }

  static completed(taskId: string, robotId: string, message: string): Alert {
    return new Alert('completed', message, false, taskId, robotId);
  }

  /** 경로 없음 — 관제 조치(수동제어) 필요 */
  static noPath(taskId: string, robotId: string, message: string): Alert {
    return new Alert('no_path', message, true, taskId, robotId);
  }

  /** 작업 실패 + 글로벌 큐 반납 — 관제 조치(확인) 필요. 전복(에러)처럼 모달로 띄운다. */
  static taskFailed(taskId: string, robotId: string, message: string): Alert {
    return new Alert('task_failed', message, true, taskId, robotId);
  }

  /** 전복 감지 — 관제 조치 필요 */
  static fall(robotId: string, message: string): Alert {
    return new Alert('fall', message, true, undefined, robotId);
  }

  /** 로봇 오프라인(태스크 중단) — 관제 조치 필요 */
  static robotOffline(robotId: string, message: string): Alert {
    return new Alert('robot_offline', message, true, undefined, robotId);
  }

  /** 배터리 부족 — 관제 조치(확인/자동충전) 필요 */
  static lowBattery(robotId: string, message: string): Alert {
    return new Alert('low_battery', message, true, undefined, robotId);
  }

  /** 배터리 충전/회복 — 알림만(조치 불필요, 토스트로 표시) */
  static charged(robotId: string, message: string): Alert {
    return new Alert('charged', message, false, undefined, robotId);
  }
}
