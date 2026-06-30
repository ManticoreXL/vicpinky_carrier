import { RosStep, TaskType } from './task.schema';

export class CreateTaskDto {
  task_id?: string;
  label?: string; // 표시용 이름(커스텀 태스크 정의 이름)
  type: TaskType;
  targetNode?: string; // CHARGE는 목적지 미선택(추후 배차)이라 선택값
  priority?: number;
  seq?: number; // 연속 내 순번(같은 로봇 큐 정렬용). 단건은 0/미지정.
  batchId?: string | null; // 연속 식별자(UI 그룹핑). 단건은 미지정.
  scenarioId?: string | null; // 시나리오 식별자(로봇 무관 순차 실행). 단건/연속은 미지정.
  repeat?: boolean; // 반복 수행(연속). 단건/비반복은 미지정/false.
  preferredRobotId?: string;
  assignedRobotId?: string | null; // 생성 시 로봇 확정(연속 태스크는 전부 같은 로봇 id를 미리 박는다)
  draft?: boolean; // true면 DRAFT(등록만, 할당 불가), 아니면 PENDING(할당 대기)
  rosPlan?: RosStep[]; // 커스텀 혼합 스텝(move/service/topic/wait). 있으면 dispatch가 경로계산 없이 이 플랜을 그대로 실행.
}
