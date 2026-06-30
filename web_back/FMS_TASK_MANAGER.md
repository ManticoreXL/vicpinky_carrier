# FMS Task Manager — 코드 구조 / 로직 (현재 코드 기준)

> `web_back`의 FMS(Fleet Management System) **태스크 매니저**를 현재 코드 기준으로 정리한 **단일 문서**.
> 이전에 흩어져 있던 `FMS.md` / `FMS_LOGIC_MAP.md`(루트·web_back) / `FMS_TASK_ASSIGNMENT.md` / `task.md` 를 이 문서로 통합·대체한다.
>
> 명명 갱신: 실행 진입 서비스는 **`TaskPlannerService`**(과거 `DispatchService`), 진입 메서드는 **`planTask`**(과거 `dispatchTask`).
> 단, 외부 파사드 `TaskManagerService.dispatchTask` 는 호환을 위해 **이름 유지**(내부에서 `planner.planTask` 호출).

---

## 0. 핵심 모델 — "수동 단일명령 + 선택적 자동화"

`TaskManagerService` 는 **오케스트레이터(파사드)** 이며, 백엔드는 로봇을 기본적으로 자동 스케줄링하지 않는다.

- 사용자가 `robotId` 를 지정해 **한 번에 하나의 동작**을 명령한다(이동 / 구호 / 공급 / 충전 / 복귀 / 일시정지).
- 자동화(auto-dispatch / auto-charge / auto-task)는 **토글로 켤 때만** 동작한다.
- 유일한 주기 작업은 **상태 갱신 tick** (`STATUS_REFRESH_MS = 2_000`, `task-manager.service.ts`):
  ```
  monitor.syncOnlineStatus()     # 온/오프라인·충전표시·저배터리·전복 동기화
  exec.checkNodeConflicts()      # 충돌 양보(1-ahead 우선순위→FIFO) — 교차점 정지/재출발 ▶ FMS_TRAFFIC_MANAGER.md
  autoTask.refreshIfEnabled()    # (auto-task ON) 트리거 정의 캐시 갱신
  autoDispatcher.runIfEnabled()  # (auto-dispatch ON) 미배정 태스크 자동 배정
  autoCharger.runIfEnabled()     # (auto-charge ON) 저배터리 로봇 충전소 배차
  ```
  순서가 중요: 동기화(전복→실패·재등록) → 충돌 양보 → 자동 디스패치. 재등록 태스크가 같은 주기에 바로 배차된다.
  **교통/충돌 회피 상세는 별도 문서 `FMS_TRAFFIC_MANAGER.md`, ROS 도메인 통신은 `FMS_DOMAIN_BRIDGE.md` 참고.**

---

## 1. 데이터 모델 — 2계층 (정의 vs 실행)

| 계층 | 클래스 / 컬렉션 | 의미 | 파일 |
|---|---|---|---|
| **실행/이력** | `TaskHistory` / `fms_tasks` | 배차된 한 번의 실행 (상태·경로·`rosPlan`·`rosCursor`·`seq`·`batchId`·`scenarioId`) | `fms/task.schema.ts` |
| **정의(템플릿)** | `Task` / `fms_task_defs` | 재사용 태스크 청사진 (`steps`·`triggerTopic`) | `task-catalog/task-catalog.schema.ts` |
| **정의(시나리오)** | `TaskSequence` / `fms_task_sequences` | 정의들의 seq 순 핸드오프 (`items[]`) | `task-catalog/task-catalog.schema.ts` |

정의(Task/TaskSequence)는 **실행되면** `TaskHistory` 로 인스턴스화된다(`runTaskDef` / `runSequence`). 정의 자체는 실행되지 않는다.

### TaskType (`task.schema.ts`)
`MOVE`(이동) · `PROCESS`(구호) · `SUPPLY`(공급) · `CHARGE`(충전) · `RECALL`(복귀=초기위치) · `PAUSE`(일시정지)

### TaskStatus (`task.schema.ts`)
`DRAFT`(등록만) → `PENDING` → `ASSIGNED` → `RUNNING` → `COMPLETED` / `FAILED`, 그리고 `SUSPENDED`(관제 조치 대기, PAUSE 보류)

### RobotStatus (`robot/robot.schema.ts`) — 상태 DB 단일 작성자 = `RobotService.updateStatus`
- 공통: `IDLE` · `RETURNING` · `PAUSED` · `ERROR`(전복) · `OFFLINE`
- 작업/충전: `WORKING`(이동·구호·공급 **통합** — 구체 작업은 활성 태스크에서 파생) · `TO_CHARGE`(충전소 이동) · `CHARGING` · `WAITING_CHARGE`(충전소 만석→초기위치 대기)
- vicpinky 캐리어: `PARKED` · `TO_LOAD` · `LOADING` · `LOADED` · `UNLOADING` · `CARRIER_UP` · `CARRIER_DOWN`
- `online = status !== OFFLINE` (백엔드가 관리, 프론트는 표시만)

### RosStep — "ROS 출력 한 스텝" (`task.schema.ts`)
dispatch 시점에 미리 계산해 `TaskHistory.rosPlan[]` 에 저장하고, `rosCursor` 로 한 스텝씩 진행한다.
- `kind`: `move`(노드 주행) | `service` | `action` | `topic` | `wait` | `signal`
- 완료조건: move=노드 도착 / service=응답 / action=result / topic=즉시 / wait=`waitMs` / signal=`awaitTopic` 신호
- `{robot}` 토큰은 실행 시 실제 로봇 id 로 치환

---

## 2. 파일 지도 (현재 구조)

배치 원칙: **결합 0(순수 스토어/유틸)은 최상위 `fms-*` 폴더로**, **결합 있는 로직은 `fms/`** 에 둔다.

```
src/
├─ fms/                          # FMS 핵심 (결합 있는 로직)
│  ├─ task-manager.service.ts    # ★ 오케스트레이터(파사드) + 2초 상태 tick + 외부 API
│  ├─ fms.controller.ts          # HTTP API (/api/fms/*)
│  ├─ fms.module.ts              # DI 배선
│  ├─ task.schema.ts             # TaskHistory(fms_tasks) + RosStep + TaskType/TaskStatus
│  ├─ task.dto.ts                # CreateTaskDto
│  ├─ task-repository.service.ts # DB CRUD/조회/목록 (상태전이 제외)
│  ├─ task-status.service.ts     # 상태 전이(ASSIGNED/RUNNING/returnToQueue…) + 브로드캐스트
│  ├─ task-planner.service.ts    # ★ 실행 진입 planTask + 타입별 핸들러(nav/recall/pause/supply 통합)
│  ├─ task-execution.service.ts  # ★ ROS 발행/스텝엔진(rosPlan/cursor)/도착감지/completeTask
│  ├─ node-lock.service.ts       # 노드 잠금 (TopologyService 래퍼) — 충돌 회피
│  ├─ global-task-queue.service.ts # 생성 façade(enqueue/register/batch/scenario) + 로봇 랭킹
│  ├─ charging.service.ts        # 충전소 점유 "조회 전용"(선택 로직 없음)
│  ├─ robot-monitor.service.ts   # ★ 텔레메트리 라우팅 + 온/오프라인·충전·전복·저배터리
│  ├─ auto-dispatcher.service.ts # 자동 배정 (on/off)
│  ├─ auto-task.service.ts       # ROS 신호→태스크 자동 생성 규칙엔진 (현재 활성 규칙 0)
│  ├─ auto-charger.service.ts    # 자동 충전 reconcile (on/off)
│  ├─ robot-priority.ts          # 로봇 적합도 비교(순수 함수)
│  └─ task-priority.ts           # 태스크 우선순위 비교(순수 함수)
├─ fms-shared/                   # 결합 0: 타입·상수·헬퍼
│  ├─ task-manager.types.ts      #   TaskManagerAlert, RobotCache
│  ├─ task-manager.constants.ts  #   임계값/타임아웃 상수
│  └─ task-manager.helpers.ts    #   emptyCache, isTerminalStatus, getPath
├─ fms-state/                    # 결합 0: 런타임 인메모리 스토어
│  ├─ robot-state.service.ts     #   cache/home/online Map (휘발성 상태 단일 owner)
│  └─ robot-task-queue.service.ts # 로봇별 순차 실행(active Map + dispatchNext/advanceScenario)
├─ fms-events/                   # 결합 0: 관제 알림
│  ├─ task-manager-events.service.ts # Socket.IO 서버 핸들 + emit/broadcast
│  └─ alert.ts                   #   Alert 값 객체(의미별 팩토리)
├─ task-catalog/                 # 정의 계층 (Task/TaskSequence 저장·로드)
├─ core-events/                  # 인프로세스 이벤트버스(CoreEventBus) — Map→FMS 단방향
└─ common/battery.ts             # 배터리% 정규화/검증 순수 헬퍼
```

---

## 3. 서비스 책임 & 의존 방향 (순환 없음)

```
TaskManagerService (facade)
  ├─ GlobalTaskQueueService   (생성: enqueue/register/batch/scenario, 로봇 랭킹)
  ├─ TaskPlannerService       (실행 진입 planTask + 타입별 핸들러) ──▶ TaskExecutionService (ROS 스텝엔진)
  ├─ RobotMonitorService      (텔레메트리→상태) ──▶ TaskExecution.onAmclPose / completeTask
  ├─ AutoDispatcher / AutoCharger / AutoTask  (자동화 토글)
  ├─ TaskStatusService (상태전이)  /  TaskRepositoryService (CRUD)
  ├─ RobotTaskQueueService (로봇별 순차) ──▶ TaskPlannerService (지연 require로 순환 회피)
  ├─ NodeLockService → TopologyService
  └─ leaf: TaskManagerEventsService, RobotStateService, ChargingService
```
> `robot-task-queue` ↔ `task-planner` 순환은 `ModuleRef` + 런타임 `require` 로 끊는다(`robot-task-queue.service.ts`).

---

## 4. 실행 모드 — 단건 / 연속 / 시나리오 / 빌더 (★ 멀티모드)

데이터는 **정의(템플릿) → 실행 모드(인스턴스화) → 단일 실행 파이프라인(`planTask`)** 구조다. 네 모드가 같은 평면이 아니라 **한 축(체인 전략)의 특수화**다.

| 모드 | 엔드포인트 | 생성 함수 | 로봇 수 | 순차 진행 주체 | 식별 필드 |
|---|---|---|---|---|---|
| **단건** | `POST tasks` | `enqueue` / `register` | 1 | (없음) | — |
| **연속(Batch)** | `POST tasks/batch` | `enqueueBatch` | **1대 고정** | `RobotTaskQueueService.dispatchNext` | `batchId`, `seq`, `repeat` |
| **시나리오** | `POST tasks/scenario` | `enqueueScenario` | **스텝별 다름** | `RobotTaskQueueService.advanceScenario` | `scenarioId`, `seq` |
| **빌더 정의 실행** | `POST task-defs/:id/run` · `sequences/:id/run` | `runTaskDef`→단건 / `runSequence`→시나리오 | 1 / 다수 | 위와 동일 | `rosPlan`(혼합 스텝) |
| **자동 생성(Trigger)** | `POST auto-task` | 트리거 기반 | 추천 자동 | — | `triggerTopic` |

모든 모드는 결국 **단일 실행 진입점 `TaskPlannerService.planTask(taskId)`** 로 수렴한다.

### ② 연속(Batch) — "한 로봇에게 여러 작업을 순서대로"
```
POST tasks/batch { preferredRobotId, tasks:[...], repeat }
  enqueueBatch → N개 TaskHistory(PENDING): 전부 같은 preferredRobotId / seq=0,1,2… / 공유 batchId / repeat
  → 첫(seq=0) 즉시 dispatchTask
  완료마다 ──► dispatchNext(robotId): findOne({PENDING, preferredRobotId, scenarioId:null}).sort({seq,createdAt})
  repeat=true ──► restartRepeatCycle (전 스텝 COMPLETED 시 재시작) / 정지 ──► POST tasks/batch/:id/stop
```
핵심: **단일 로봇 · seq · FIFO 체인.** 로봇은 active 1개만 수행, 끝나면 `dispatchNext`가 같은 로봇 큐의 다음을 꺼낸다.

### ③ 시나리오(Scenario) — "스텝마다 다른 로봇이 이어받기"
```
POST tasks/scenario { steps:[{ type, targetNode, preferredRobotId }, ...] }
  enqueueScenario → N개 TaskHistory(PENDING): 공유 scenarioId / seq=0,1,2… / preferredRobotId 스텝별 상이 ★
  → 첫 스텝 즉시 dispatchTask
  스텝 완료마다 ──► advanceScenario(taskId): findOne({scenarioId:X, PENDING}).sort({seq}) → 다음 스텝(로봇 무관) ★
```
연속과의 결정적 차이 2가지: (1) 스텝마다 로봇이 다를 수 있다, (2) 진행 주체가 `dispatchNext`(로봇별)가 아니라 `advanceScenario`(시나리오별)다.
**이중 실행 방지**: `dispatchNext` 는 쿼리에 `scenarioId:null` 을 걸어 시나리오 스텝을 제외 → 시나리오는 오직 `advanceScenario` 로만 전진.

### ④ 빌더(정의) — 독립 모드 아님, "템플릿 + 재사용"
빌더는 혼합 스텝(`steps`/`rosPlan` = move/service/topic/wait)을 가진 정의를 만든다.
`runTaskDef`(→단건 경로) / `runSequence`(→시나리오 경로)로 **기존 실행 경로를 재사용**한다. 정의에 `steps`가 있으면 실행 레코드 `rosPlan`에 그대로 실리고(경로계산 없이 `handleCustomPlan`), 없으면 `type+targetNode`만 실려 표준 경로계산을 탄다.

> 요약: **단건은 연속의 N=1**, **연속은 시나리오의 "전 스텝 같은 로봇" 특수케이스**. 실질 분기점은 체인 주체 `dispatchNext` ↔ `advanceScenario` 단 하나.

---

## 5. 로봇 할당 (누구에게?) — 모든 모드 공통

할당은 **실행 진입(`planTask`) 이전에 `preferredRobotId` 로 이미 결정**된다. 4가지 경로:
```
1) 명시 지정    사용자가 robotId 지정 (단건 dispatch / 연속 robotId / 시나리오 스텝 로봇 / 정의 preferredRobotId)
2) 추천 자동    미지정 시 recommendRobot() → robot-priority 1순위
                 (제외: 오프라인·오류·일시정지 → 큐 적은 순 → 배터리 많은 순 → 거리 가까운 순)
                 · 시나리오/시퀀스는 taken Set 으로 단계마다 "다른 로봇" 우선  · SUPPLY 는 omx 고정
3) 자동 디스패처 auto-dispatch ON → 주기적으로 PENDING 을 랭킹으로 배정·재배정
4) 선점         RECALL·PAUSE 는 랭킹 없이 지정 로봇 직행 + active 선점
```
`task-manager.service.ts`(`recommendRobot`) · `robot-priority.ts`(랭킹) · `auto-dispatcher.service.ts`(주기 배정).

---

## 6. 실행 — 단일 진입점 `planTask` (`task-planner.service.ts`)

```
planTask(taskId)
  └ 검증: 서버有 · PENDING · robotId有 · (선점 아니면)비busy · 온라인 · 非ERROR
  └ 분기:
       rosPlan 있음(빌더 정의) → handleCustomPlan : 경로계산 없이 저장 스텝 실행
       PAUSE                  → handlePause     : cancelNav+hardStop, 진행분 SUSPENDED, 자신 즉시 COMPLETED
       RECALL                 → handleRecall    : 보유 태스크 큐 반납 + 초기위치(initPosition) 복귀
       SUPPLY                 → handleSupply    : vision/start_inference 발행 + is_loaded 대기(30s 타임아웃)
       그 외(MOVE/PROCESS/CHARGE) → handleNav    : resolvePath → pathfinding(Dijkstra) → buildRosPlan → exec.startPlan
  └ exec.startPlan → sendStep(goal_pose / navigate_to_pose) → 도착감지 → advance(rosCursor++) → 완료
```
완료 시 `dispatchNext`(연속) / `advanceScenario`(시나리오)가 호출돼 체인이 이어진다.
`movingStatusFor`: CHARGE→`TO_CHARGE`, RECALL→`RETURNING`, 그 외(MOVE/PROCESS/SUPPLY)→`WORKING`(작업 통합).

### 타입별 처리 요약
| 타입 | 핸들러 | ROS 출력 | 완료 / 실패 | 로봇 상태 |
|---|---|---|---|---|
| **MOVE** | `handleNav` | goal_pose / nav action | 최종 노드 도착→`completeTask` | `WORKING` |
| **PROCESS** | `handleNav` | 동일 | 동일 | `WORKING` |
| **CHARGE** | `handleNav` | 동일 | 도착 노드가 CHARGER면 `CHARGING`(태스크 COMPLETED) ⚠️ §11 | `TO_CHARGE` |
| **RECALL** | `handleRecall`→`handleNav` | 큐 반납 후 `initPosition` 노드로 이동 | 도착→COMPLETED+IDLE / initPosition 없으면 FAILED | `RETURNING` |
| **SUPPLY** | `handleSupply` | `/omx/vision/start_inference` `Bool{data:true}` | `/omx/vision/is_loaded`=true→COMPLETED / 30s 타임아웃→FAILED | `WORKING` |
| **PAUSE** (preempt) | `handlePause` | `cmd_vel`=0 | 보유분 `SUSPENDED`, 자신 즉시 COMPLETED. 재개=`resumeTask`→`resumePlan` | `PAUSED` |
| **커스텀** | `handleCustomPlan` | 저장 스텝 그대로 | 스텝별 완료 | 타입별 |

---

## 7. ROS 배관 & 도착/완료 감지 (`task-execution.service.ts`)

### 공통 배관
- **발행(다운링크)**: `TaskExecutionService` / `TaskPlannerService` → `RosService.publish()` → rosbridge WebSocket → `ros_packages/domain_bridge/*.yaml`(허브 도메인 49 ↔ 로봇 도메인) → 로봇.
- **수신(업링크)**: rosbridge → `RosService.onMessage` 핸들러(`RobotMonitorService` 등). 구독 목록 = `ros/ros.types.ts:SUBSCRIBED_TOPICS`.
- **테스트봇(`TEST-BOT*`)**: `VirtualRobotService` 가 goal_pose/cmd_vel/initialpose 발행을 가로채 시뮬레이션하고 amcl_pose/odom/battery_state/imu 를 주입 → 실로봇과 동일 핸들러 경유.

### 태스크별 토픽
| 태스크 | 발행 토픽 / 타입 | 완료 감지 |
|---|---|---|
| MOVE / PROCESS | `/{r}/goal_pose` `PoseStamped`(노드마다) | amcl_pose 도착 → `checkWaypointArrival` → `completeTask` |
| SUPPLY | `/omx/vision/start_inference` `Bool{data:true}` | `/omx/vision/is_loaded`=true → `onSupplyLoaded` / 30s→FAILED |
| RECALL | `findInitPositionNode` 해석 후 `goal_pose` | MOVE 동일 |
| PAUSE | `/{r}/cmd_vel` 0 | 즉시 COMPLETED, 재개=`resumePlan`로 goal_pose 재전송 |
| CHARGE | (목적지 해석 단계 없음) ⚠️ §11 | 도착 노드 CHARGER면 CHARGING |

### 도착 판정 — 실봇 vs 테스트봇 (이원화)
- **실 TB3(`robotId.startsWith('tb3')`)**: `navigate_to_pose` 액션 결과 — `status===3`(SUCCEEDED) 도착 / `===4`(ABORTED) 실패(`onNavResult`). amcl 임계 미사용.
- **TEST/기타 봇**: `goal_pose` 발행 + `amcl_pose` 거리 임계(`checkWaypointArrival`). 재진입 가드(`waypointProcessing`).
- **적응형 임계**(`computeArrivalThreshold`): `TEST*`→`0.05m` / 최종노드→`0.5m`(`NODE_ARRIVE_M`) / 중간노드→`min(1.5, max(0.15, segLen*0.15))`.
- `completeTask`: active 해제 → COMPLETED → (CHARGER면 CHARGING+잠금유지, 아니면 IDLE+잠금/점유 해제) → `Alert.completed` → `dispatchNext`+`advanceScenario`.
- 한계: **vicpinky/omx 는 amcl_pose 미구독** → vicpinky 노드 주행 도착감지 불가(범위 외), omx 는 공급 전용이라 무관.

---

## 8. 두 개의 "큐" — 글로벌 vs 로봇별

**인메모리 리스트 큐는 없다.** 두 "큐"는 모두 Mongo `TaskHistory.status` 의 투영이다.

| | 글로벌 큐 | 로봇별 큐 |
|---|---|---|
| 담당 | `GlobalTaskQueueService`(생성 façade) + 자동디스패처 | `RobotTaskQueueService`(`fms-state`) |
| 실체 | `status ∈ {DRAFT,PENDING}` 문서 집합 | 인메모리 `active: Map<robotId,taskId>`(실행 1개) + `preferredRobotId=robot && PENDING` 문서 |
| 꺼냄 | 외부(`dispatchTask`/autoDispatcher) | `dispatchNext` 가 **FIFO**(`seq↑, createdAt↑`) |
| 정렬 | autoDispatcher가 읽을 때 **task-priority** | seq / createdAt |

즉 **전역 우선순위(무엇 먼저)** 와 **로봇 내 FIFO(배정 후 순서)** 가 분리돼 있다.

---

## 9. 로봇 상태 전이 — 누가 설정하나

상태 DB 기록 **단일 작성자 = `RobotService.updateStatus`** (`status` + `online=status!==OFFLINE`). 변경 시 `events.broadcast('robot_status_changed', …)` → 프론트 갱신.

| 상태 | 설정 주체 |
|---|---|
| `WORKING`(이동·구호·공급 통합) / `TO_CHARGE` / `RETURNING` | `planner.handleNav`·`handleSupply`(`movingStatusFor`) |
| `PAUSED` | `planner.handlePause` |
| `CHARGING` | `exec.completeTask`(CHARGER 도착) / `monitor.reconcileChargingStatus`(battery_state) |
| `WAITING_CHARGE` | `autoCharger.sendToWaitCharge`(충전소 만석) |
| `ERROR` | `monitor.onImu`(roll/pitch>45°) — 복구 시 IDLE |
| `OFFLINE` | `monitor`(6초 무수신) — 복귀 시 online |
| `IDLE` | 완료/취소/정지/맵변경/충전완료/온라인복귀 등 다수 |

**텔레메트리 라우팅**(`monitor.handle`): 임의 토픽→`lastSeen`(온라인 판정) · `battery_state`→`batteryPct`/`charging` · `amcl_pose`→위치캐시+`exec.onAmclPose` · `imu`→`onImu`(전복).

---

## 10. 성공 / 실패 / 에러 복구(failover)

### 성공 (COMPLETED)
| 태스크 | 처리 | 다음 |
|---|---|---|
| MOVE/PROCESS/RECALL | 최종 노드 도착 → `completeTask` → **충전소면 CHARGING, 아니면 IDLE** | `dispatchNext` + `advanceScenario` |
| SUPPLY | `is_loaded`=true → COMPLETED + IDLE | 동일 |
| PAUSE | 즉시 COMPLETED, 로봇 PAUSED(진행분 SUSPENDED) | 재개 버튼 → `resumeTask` |

### 실패 (FAILED) & 자동 복구
| 원인 | 처리 | 로봇 상태 |
|---|---|---|
| 경로/목적지 없음 | FAILED + waitReason | 보통 IDLE |
| 공급 타임아웃(30s) | FAILED | LOADING |
| 취소 / 맵 변경 | FAILED | IDLE |
| 오프라인 | 진행분 FAILED | OFFLINE |
| **ERROR(전복)** | 진행 RUNNING → **FAILED + 새 PENDING 재등록**, 그 외 PENDING → **robot_id 초기화해 글로벌 큐 반납** → 다음 tick 자동 재배차 | ERROR |

> **에러 복구 서사**: 운영자가 수동 확인·재투입하던 OLD → ERROR 감지 시 작업을 글로벌 큐로 반납하고 로봇 선택 알고리즘으로 **자동 재할당**하는 NEW. `monitor.handleErrorTransition` + 2초 tick의 `autoDispatcher` 협업.

---

## 11. 자동화 (토글 3종) — 모두 2초 tick이 pull

| 토글 | 서비스 | 동작 |
|---|---|---|
| **auto-dispatch** | `AutoDispatcherService` | `findAutoDispatchable`(DRAFT/PENDING, task-priority순) → 각 태스크에 robot-priority 최상위 가용로봇 배정. **SUPPLY=omx 전용, 그 외 omx 제외**. setAutoDispatch가 auto-task도 함께 on/off |
| **auto-task** | `AutoTaskService` | ROS 신호(트리거 토픽) 매칭 시 태스크 자동 **생성**. 정의 `Task.triggerTopic` 기반. **현재 활성 규칙 0**. 쿨다운 30s |
| **auto-charge** | `AutoChargerService` | 저배터리 로봇을 가장 가까운 빈 충전소로 `CHARGE` 배차(`nearestCharger`, hop 최소); 만석이면 초기위치 `WAITING_CHARGE`; 완충(≥80%)이면 초기위치로 퇴거해 충전소 비움. 진행 작업은 선점 안 함 |

> 충전소 선택 로직은 `AutoChargerService.nearestCharger` 에 있다. `ChargingService` 는 점유 **조회 전용**.

---

## 12. 우선순위 (순수 함수)

**robot-priority.ts — 사전식 비교(가중치 없음)**, `BATTERY_OK_PCT=40`
- 1순위(전 타입): 온라인 우선
- CHARGE: 2)`!busy` → 3)배터리 **오름차순**(낮을수록 먼저=가장 급함)
- 그 외(MOVE/PROCESS/SUPPLY): 2)`!busy` → 3)배터리 `≥40` 우선 → 4)거리 **오름차순**

**task-priority.ts — 2키 내림차순**
- 키1 `STATUS_RANK`: `DRAFT 5 > PENDING/ASSIGNED 4 > RUNNING/SUSPENDED 3 > COMPLETED 2 > FAILED 1`
- 키2 `TYPE_PRIORITY`: `RECALL/PAUSE 20 > PROCESS 10 > MOVE/SUPPLY 5 > CHARGE 1`

---

## 13. 충전 "요/불필요" 로직

> 충전 요/불필요는 **태스크 성공·실패가 정하지 않는다.** 독립적인 **배터리 임계 모니터(2초)** 가 판단한다.

- **충전 요**(`checkLowBattery`): 온라인+비충전+배터리 `< LOW_BATTERY_PCT(20)` → `Alert.lowBattery`(에피소드당 1회 래치, 프론트 확인/자동충전 버튼). +5% 회복 또는 충전 시작 시 해제.
- **충전 완료/불필요**(`reconcileChargingStatus`, 진행 태스크 없을 때만): CHARGING+배터리 `≥ CHARGE_TARGET_PCT(80)` → IDLE. 명시적 방전(power_supply_status=2)도 CHARGING→IDLE. 회복 시 `Alert.charged`.

### ⚠️ CHARGE 태스크의 미완성 라이프사이클
- CHARGE 전용 핸들러 없이 `handleNav` 로 흐른다. 충전소 도착 시 로봇만 `CHARGING` 으로 바뀌고 **태스크는 즉시 COMPLETED**(실제 충전 세션/언도크 없음).
- 수동 CHARGE 는 **목적지(충전소 노드) 해석 단계가 없어** `targetNode=''` → `findNodeById('')`=null → **FAILED** 가능. (프론트 `emitFmsAutoCharge` 가 `chargerNodeId` 미전송) auto-charge 경로는 `nearestCharger` 로 목적지를 채워 정상.
- 해결: RECALL 의 `findInitPositionNode` 패턴처럼 **충전소 노드 자동 해석 한 단계**만 추가하면 연결됨.

---

## 14. 이벤트 / 알림

**Alert 팩토리(`alert.ts`)** → `events.emit` 이 `id`+`timestamp` 붙여 `task_manager_alert` 소켓 발행:

| 팩토리 | requiresAction |
|---|---|
| `info` / `assigned` / `completed` / `charged` | false |
| `noPath` / `fall` / `robotOffline` / `lowBattery` | **true** |

기타 브로드캐스트: `robot_status_changed` · `robot_registered` · `fms_task_created/updated/deleted` · `fms_tasks`.
**소비자**: Socket.IO 서버는 `gateway/ros.gateway.ts`(`afterInit`→`taskManager.setServer`)가 주입 → 전부 프론트로 나간다. 백엔드 내부 소비자 없음.
**CoreEventBus**(별개): `ROBOT_MAP_REASSIGNED`(map.service→`handleMapChange`)만 사용.

---

## 15. 상수표 (`fms-shared/task-manager.constants.ts`, env 조정 가능)

| 상수 | 값 | 용도 |
|---|---|---|
| `STATUS_REFRESH_MS` | 2000 | 상태 tick 주기 |
| `OFFLINE_AFTER_MS` | 6000 | 무수신 오프라인 판정 |
| `FALL_THRESH_RAD` | π/4 (45°) | 전복 판정 |
| `NODE_PASS_M` / `NODE_ARRIVE_M` / `TEST_ARRIVE_M` | 1.5 / 0.5 / 0.05 | 통과/도착/테스트봇 임계(m) |
| `CHARGE_TARGET_PCT` / `LOW_BATTERY_PCT` | 80 / 20 | 충전 완료 / 저배터리 하한(%) |
| `BATTERY_OK_PCT` | 40 | robot-priority 배터리 양호선 |
| `SUPPLY_TIMEOUT_MS` | 30000 | 공급 비전 적재 타임아웃 |
| `DEFAULT_COOLDOWN_MS` | 30000 | auto-task 규칙 쿨다운 |

---

## 16. HTTP API 표면 (`fms.controller.ts`, prefix `/api/fms`)

| 메서드·경로 | 동작 |
|---|---|
| `GET tasks` / `tasks/:id` | 목록(status/robot_id/limit/sort/afterMs) / 단건 |
| `GET tasks/:id/robot-ranking` / `robot-ranking` | 태스크별 / 목적지별 로봇 추천 |
| `POST tasks` | 생성 — `draft`면 DRAFT(register) 아니면 PENDING(enqueue) |
| `POST tasks/batch` / `tasks/scenario` | 연속(batchId) / 시나리오(scenarioId) 등록·실행 |
| `POST sequences/:id/run` / `task-defs/:id/run` | 저장 시나리오 / 단일 정의 실행 |
| `POST tasks/:id/dispatch` | 수동 배차(body.robotId면 지정+PENDING) → `planTask` |
| `POST tasks/:id/resume` / `tasks/batch/:batchId/stop` | 재개 / 반복연속 정지 |
| `DELETE tasks/:id/cancel` / `tasks/:id` / `queue` / `tasks` | 취소 / 삭제 / 글로벌큐비움 / 전체초기화 |
| `GET·POST auto-dispatch` / `auto-charge` / `auto-task` | 자동화 토글 조회·설정 |

> AI 태스크 생성/대화는 `AiController`(`/ai/*`) 담당 — FMS는 AI에 의존하지 않음.

---

## 17. 알려진 공백 / 데드코드 (동작엔 대체로 무해)

- **CHARGE 라이프사이클 미완성** — §13. 충전소 노드 해석 단계만 추가하면 연결.
- **`buildRosPlan` 의 SUPPLY 분기는 죽은 코드** — SUPPLY는 `handleSupply`가 먼저 가로채므로 도달 불가.
- **`alert.ts` `task_failed` 타입에 팩토리 없음** — 실패는 info/no_path로 표면화.
- **vicpinky/omx amcl_pose 미구독** — 노드 주행 도착감지 범위 외(§7).

---

## 18. 검증 (e2e)

로컬 MongoDB + 백엔드 내장 **가상 테스트봇**(`TEST-BOT*`)으로 전체 파이프라인 end-to-end 검증.
- `test/fms-pipeline.e2e-spec.ts` (+ `charging`/`custom-step`/`nav-action`/`sequence-run`/`signal-step`/`task-catalog`/`victim` e2e).
- 실행: `npm run test:e2e -- fms-pipeline` (MongoDB 필요). 시나리오: 온라인 인식 → 경로탐색·할당·주행·완료 → 로봇별 큐잉(순차 실행 증명).
```
