# FMS 태스크 할당·실행 아키텍처

> 단건 / 연속 / 시나리오 / 태스크 빌더가 각각 어떻게 **생성 → 할당 → 실행**되는지에 대한 설계 문서.
> 백엔드: NestJS + MongoDB (`web_back`). 실행 모델: **수동 단일명령 + 선택적 자동화**.

---

## 0. 핵심 전제 — 데이터가 두 계층으로 나뉜다

이 시스템 이해의 출발점은 **"정의(템플릿)"와 "실행 레코드"의 분리**다.

| 계층 | 컬렉션 | 클래스 | 역할 |
|---|---|---|---|
| **정의(템플릿)** | `fms_task_defs`, `fms_task_sequences` | `Task`, `TaskSequence` (`src/task-catalog/task-catalog.schema.ts`) | 재사용 가능한 작업 청사진. 그 자체로는 실행되지 않음 |
| **실행 레코드** | `fms_tasks` | `TaskHistory` (`src/fms/task.schema.ts`) | 실제 런타임 인스턴스 — `status` · `pathQueue` · `rosCursor` · `seq` · `batchId` · `scenarioId` 보유 |

→ **태스크 빌더는 "정의"를 만드는 도구**이고, **단건/연속/시나리오는 정의(또는 즉석 입력)를 실행 레코드로 인스턴스화하는 방식**이다.
즉 네 가지가 같은 평면에 있는 게 아니라 **빌더(작성) → 실행 모드(인스턴스화) → 단일 실행 파이프라인** 구조다.

---

## 1. 한눈에 보는 모드 비교

| 모드 | 엔드포인트 | 생성 함수 | 로봇 수 | 순차 진행 주체 | 식별 필드 |
|---|---|---|---|---|---|
| **단건** | `POST /fms/tasks` | `enqueue` / `register` | 1 | (없음, 1건) | — |
| **연속(Batch)** | `POST /fms/tasks/batch` | `enqueueBatch` | **1대 고정** | `RobotTaskQueueService.dispatchNext` | `batchId`, `seq`, `repeat` |
| **시나리오** | `POST /fms/tasks/scenario` | `enqueueScenario` | **스텝별 다름** | `RobotTaskQueueService.advanceScenario` | `scenarioId`, `seq` |
| **빌더 정의 실행** | `POST /fms/task-defs/:id/run`<br>`POST /fms/sequences/:id/run` | `runTaskDef`→단건<br>`runSequence`→시나리오 | 1 / 다수 | 위와 동일 | `rosPlan`(혼합 스텝) |
| **자동 생성(Trigger)** | `POST /fms/auto-task` | 트리거 기반 자동 생성 | 추천 자동 | — | `triggerTopic` |

모든 모드는 결국 **단일 실행 진입점 `TaskPlannerService.planTask(taskId)`** 로 수렴한다.

---

## 2. 모드별 상세

### ① 단건 (Single)
가장 기본. 실행 레코드 1건을 만들되 **자동 실행하지 않고** 사용자가 명시적으로 디스패치한다.

```
POST /fms/tasks  { type, targetNode, preferredRobotId, priority, draft? }
   │
   ├─ draft=true  → register() → TaskHistory(DRAFT)        // 보관만
   │                   └─ POST /fms/tasks/:id/release → PENDING
   └─ draft=false → enqueue()  → TaskHistory(PENDING)      // 대기열 등록
                        │
         POST /fms/tasks/:id/dispatch → planTask()         // 사용자가 실행
```

- **생성 ≠ 실행.** PENDING으로 두고 사용자가 실행해야 움직인다(수동 단일명령 모델).
- `task-manager.service.ts` — `enqueue`, `register`, `releaseTask`, `dispatchTask`

### ② 연속 (Batch) — "한 로봇에게 여러 작업을 순서대로"

```
POST /fms/tasks/batch  { preferredRobotId, tasks:[...], repeat }
   │ enqueueBatch(robotId, items, repeat)                 (global-task-queue.service.ts)
   │   → N개 TaskHistory(PENDING) 생성
   │       · 전부 preferredRobotId = 같은 robotId
   │       · seq = 0,1,2…  /  공유 batchId  /  repeat 플래그
   │   → 첫(seq=0) 태스크 즉시 dispatchTask                (task-manager.service.ts)
   │
   완료될 때마다 ──► RobotTaskQueueService.dispatchNext(robotId)
        findOne({ PENDING, preferredRobotId, scenarioId:null }).sort({ seq, createdAt })
        → 그 로봇의 다음 seq 태스크 실행 (FIFO 체인)
   │
   repeat=true ──► restartRepeatCycle: 전 스텝 COMPLETED 시 PENDING으로 리셋·재시작
   정지        ──► POST /fms/tasks/batch/:batchId/stop → stopBatch (재시작 차단 + 즉시 IDLE)
```

- 핵심: **단일 로봇 · seq 순서 · FIFO 체인.** 로봇은 한 번에 active 1개만 수행, 끝나면 `dispatchNext`가 같은 로봇 큐에서 다음을 꺼낸다.
- `robot-task-queue.service.ts` — `dispatchNext`, `restartRepeatCycle`

### ③ 시나리오 (Scenario) — "스텝마다 다른 로봇이 이어받기"

```
POST /fms/tasks/scenario  { steps:[{ type, targetNode, preferredRobotId }, ...] }
   │ enqueueScenario(steps)                               (global-task-queue.service.ts)
   │   → N개 TaskHistory(PENDING) 생성
   │       · 공유 scenarioId  /  seq = 0,1,2…
   │       · preferredRobotId = 스텝별로 다를 수 있음 ★
   │   → 첫 스텝 즉시 dispatchTask                          (task-manager.service.ts)
   │
   스텝 완료될 때마다 ──► RobotTaskQueueService.advanceScenario(taskId)
        findOne({ scenarioId:X, PENDING }).sort({ seq })
        → 다음 스텝 dispatch (로봇 무관 — 다른 로봇이어도 됨) ★
```

- 핵심: **다중 로봇 · seq 순서 · 로봇 무관 핸드오프.** 연속과 결정적 차이 두 가지: (1) 스텝마다 로봇이 다를 수 있다, (2) 진행 주체가 `dispatchNext`(로봇별)가 아니라 `advanceScenario`(시나리오별)다.
- **연속과 충돌 방지**: `dispatchNext`는 쿼리에 `scenarioId:null`을 걸어 시나리오 스텝을 제외 → 시나리오는 오직 `advanceScenario`로만 전진(이중 실행 방지).

### ④ 태스크 빌더 (정의 작성 → 실행)
빌더(`BuilderView`)는 **혼합 스텝(`steps`/`rosPlan`)을 가진 정의**를 작성한다.
`RosStep` = `move`(goal_pose 도착) / `service` / `topic`(전역 신호) / `wait` 혼합.

```
빌더 작성 ──► Task 정의(fms_task_defs)   또는   TaskSequence(fms_task_sequences)
                                                   └ items[] = Task 참조 + seq + robotId override

실행:
 POST /fms/task-defs/:id/run  → runTaskDef
    정의 → TaskHistory 1건(enqueue) { rosPlan: def.steps } → dispatch     ⟹ ① 단건 경로 재사용
 POST /fms/sequences/:id/run  → runSequence
    items 순회 → 각 단계 robot 해석 → dtos[] { rosPlan: def.steps }
                → enqueueScenario(dtos)                                   ⟹ ③ 시나리오 경로 재사용
```

- 핵심: **빌더는 독립 실행 모드가 아니라 "템플릿 + 재사용".** 정의에 `steps`(혼합 스텝)가 있으면 실행 레코드의 `rosPlan`에 그대로 실리고, 없으면 `type+targetNode`만 실려 표준 경로계산을 탄다.
- `task-catalog.schema.ts` (`Task.steps`, `TaskSequence.items`), `task-manager.service.ts` (`runTaskDef`, `runSequence`)

### (+) 자동 생성 (Trigger)
`Task` 정의의 `triggerTopic`/`triggerField`/`triggerValue`가 채워져 있고 auto-task 모드가 켜지면, 해당 ROS 신호 수신 시 그 정의로 태스크를 **자동 생성·배차**한다(`auto-task.service.ts`). 이벤트 구동 생성 경로.

---

## 3. 로봇 할당 (누구에게?) — 모든 모드 공통

할당은 **실행 진입(`planTask`) 이전에 이미 `preferredRobotId`로 결정**된다. 결정 방식 4가지:

```
1) 명시 지정      사용자가 robotId 지정 (단건 dispatch, 연속 robotId, 시나리오 스텝 로봇, 정의 preferredRobotId)
2) 추천 자동      미지정 시 recommendRobot() → robot-priority 랭킹 1순위
                   (제외: 오프라인·오류·일시정지 → 큐 적은 순 → 배터리 많은 순 → 거리 가까운 순)
                   · 시나리오/시퀀스는 taken Set으로 단계마다 "다른 로봇" 우선
                   · SUPPLY는 무조건 omx 고정
3) 자동 디스패처   auto-dispatch 모드 ON → 주기적으로 PENDING을 랭킹으로 배정·재배정
4) 선점           RECALL(복귀)·PAUSE(일시정지)는 랭킹 없이 지정 로봇 직행 + active 선점
```

- `task-manager.service.ts` — `recommendRobot`
- `src/fms/robot-priority.ts` — 랭킹 규칙(제외 → 큐 개수 → 배터리 → 거리)
- `auto-dispatcher.service.ts` — 주기 자동 배정

---

## 4. 실행 (어떻게?) — 단일 진입점 `planTask`

생성 모드가 무엇이든 실제 실행은 전부 `TaskPlannerService.planTask(taskId)`로 모인다.

```
planTask(taskId)                                         src/fms/task-planner.service.ts
  └ 검증: 서버有 · PENDING · robotId有 · (선점 아니면)로봇 비busy · 온라인 · 非ERROR
  └ 분기:
       rosPlan 있음(빌더 정의) → handleCustomPlan : 경로계산 없이 스텝 그대로 실행(resolveStep)
       PAUSE                   → handlePause     : 즉시 정지 + 진행 태스크 SUSPENDED 보류
       RECALL                  → handleRecall    : 보유 태스크 반납 + 초기위치 복귀
       SUPPLY                  → handleSupply    : 비전 추론(start_inference) + is_loaded 대기
       그 외(MOVE/PROCESS/CHARGE)→ handleNav       : Pathfinding(Dijkstra) → buildRosPlan → exec.startPlan
  └ TaskExecutionService.startPlan → sendStep(goal_pose / navigate_to_pose) → 도착감지 → advance → 완료
```

완료 시 다시 `dispatchNext`(연속) / `advanceScenario`(시나리오)가 호출돼 체인이 이어진다.

> 참고: 실행 진입 서비스는 `TaskPlannerService`(과거 `DispatchService`에서 개명), 진입 메서드는 `planTask`(과거 `dispatchTask`). 외부 파사드 `TaskManagerService.dispatchTask`는 호환을 위해 이름 유지.

---

## 5. 두 개의 "큐"가 따로 있다 (자주 헷갈리는 지점)

| 큐 | 담당 | 정렬 기준 | 용도 |
|---|---|---|---|
| **글로벌 대기열** | `GlobalTaskQueueService` + 자동디스패처 | 상태 → 유형 우선순위 (`task-priority.ts`) | "무엇을 먼저 배차할지" |
| **로봇별 실행 체인** | `RobotTaskQueueService` | `seq → createdAt` (FIFO) | "배정된 로봇이 다음에 뭘 할지" |

즉 **전역 우선순위(어떤 작업 먼저)** 와 **로봇 내 FIFO(배정 후 순서)** 가 분리돼 있다.

---

## 6. 설계 정리 — "모드가 많아 보이지만 한 축의 특수화"

```
            ┌── 단건      = N=1, 단일 로봇
연속/시나리오 ┤── 연속      = N개, 단일 로봇, dispatchNext 체인
            └── 시나리오   = N개, 다중 로봇, advanceScenario 체인
빌더(정의)   = 위 실행들에 "혼합 스텝(rosPlan)"을 공급하는 템플릿 계층
```

- **단건은 연속의 N=1 특수케이스**, **연속은 시나리오의 "전 스텝 같은 로봇" 특수케이스**에 가깝다.
- 실제로 다른 코드 경로가 필요한 건 **체인 주체 단 1가지 차이**(`dispatchNext` ↔ `advanceScenario`)뿐이고, 나머지(생성·할당·실행)는 전부 공유한다.
- 빌더는 별도 실행 모드가 아니라 `runTaskDef`(→단건) / `runSequence`(→시나리오)로 **기존 경로를 재사용**한다.

→ 설계 서술의 핵심: **"단일 실행 파이프라인(`planTask`) 위에, 생성 형태(단건/배치/시나리오)와 작성 도구(빌더)를 레이어링한 구조."**
유일한 실질 통합 포인트는 `dispatchNext`/`advanceScenario`를 "체인 전략"으로 추상화하는 정도.

---

## 부록 — 파일 색인

| 관심사 | 파일 |
|---|---|
| 생성·대기열 | `src/fms/global-task-queue.service.ts` (`enqueue`/`Batch`/`Scenario`) |
| 외부 API 파사드 | `src/fms/task-manager.service.ts` (`runTaskDef`/`runSequence`/`recommendRobot`) |
| 정의(템플릿) | `src/task-catalog/task-catalog.service.ts`, `task-catalog.schema.ts` |
| 실행 진입(플래너) | `src/fms/task-planner.service.ts` (`planTask`) |
| 스텝 실행 | `src/fms/task-execution.service.ts` (`startPlan`/`sendStep`) |
| 로봇별 체인 | `src/fms-state/robot-task-queue.service.ts` (`dispatchNext`/`advanceScenario`) |
| 로봇 랭킹 | `src/fms/robot-priority.ts` |
| 우선순위 정렬 | `src/fms/task-priority.ts` |
| 경로계산 | `src/pathfinding/pathfinding.service.ts` (Dijkstra) |
| HTTP 엔드포인트 | `src/fms/fms.controller.ts` |
