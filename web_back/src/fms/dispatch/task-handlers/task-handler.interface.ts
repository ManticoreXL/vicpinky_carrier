import { TaskDocument } from '../../task.schema';
import { RobotDocument } from '../../../robot/robot.schema';

/**
 * 태스크 타입별 실행 전략 공통 인터페이스.
 *
 * DispatchService 가 "어떤 로봇에 어떤 태스크를" 까지 정하고 나면, 실제 그 타입의
 * 일을 어떻게 수행할지는 각 핸들러가 책임진다 (SUPPLY=즉시 보급, 나머지=경로주행).
 */
export interface TaskHandler {
  /**
   * 로봇에 태스크를 실행 착수시킨다.
   * @returns true 면 로봇이 주행 등으로 점유됨(=활성 태스크 보유), false 면 미착수/즉시완료.
   */
  handle(robot: RobotDocument, task: TaskDocument, taskId: string): Promise<boolean>;
}
