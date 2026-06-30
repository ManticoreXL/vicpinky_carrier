# FMS Task Manager — 코드 구조 / 로직 지도 (현재 코드 기준)

> `web_back`의 FMS(Fleet Management System) **태스크 매니저 서브시스템**을 현재 코드 기준으로 정리한 문서.
>
> - 이 문서는 **현재의 flat `src/fms/` 구조**를 반영한다.
> - `web_back/FMS_LOGIC_MAP.md` 는 **옛 구조(삭제된 `fms/dispatch/`·`navigation/`·`monitor/`·`queue/` 하위폴더 + 핸들러)** 를 설명하는 **stale 문서**다. 구조 파악은 이 문서를 따른다.
> - `task.md`(repo 루트) 는 **태스크↔ROS 배관·상태전이·충전**을 다루는 보완 문서다(현재 코드와 일치).

---

## 0. 핵심 모델 — "수동 단일 명령"

`TaskManagerService` 는 **오케스트레이터(파사드)** 이며, 백엔드는 로봇을 자동 스케줄링하지 않는다.

- 사용자가 `robotId` 를 지정해 **한 번에 하나의 동작**을 명령한다(노드 이동 / 충전소 / 공급 / 정지 / 복귀 / 초기위치).
- 과거의 자동 동작(1초 tick 자동할당·충돌 양보·AMCL 자동복구·코너 자동회전·오프라인 자동 재할당)은 **제거됨**.
- 유일한 주기 작업은 **상태 "표시" 갱신 tick** (`STATUS_REFRESH_MS = 2_000`, `task-manager.service.ts:71`):
  ```
  monitor.syncOnlineStatus()        # 온/오프라인·충전표시·저배터리·전복 동기화
  autoTask.refreshIfEnabled()       # (자동 ON일 때) 트리거 정의 캐시 갱신
  autoDispatcher.runIfEnabled()     # (자동 ON일 때) 미배정 태스크 자동 배정
  autoCharger.runIfEnabled()        # (자동 ON일 때) 저배터리 로봇 충전소 배차
  ```
  순서가 중요: 동기화(전복→실패·재등록)를 먼저 끝낸 뒤 자동 디스패치 → 재등록 태스크가 같은 주기에 바로 배차.

---

## 1. 데이터 모델 — 2계층 (실행 vs 정의)

| 계층 | 클래스 / 컬렉션 | 의미 | 파일 |
|---|---|---|---|
| **실행/이력** | `TaskHistory` / `fms_tasks` | 배차된 한 번의 실행 (상태·경로·진행) | `fms/task.schema.ts` |
| **정의(템플릿)** | `Task` / `fms_task_defs` | 재사용 태스크 정의 | `task-catalog/task-catalog.schema.ts` |
| **정의(시나리오)** | `TaskSequence` / `fms_task_sequences` | 정의들의 seq 순 핸드오프 | `task-catalog/task-catalog.schema.ts` |

정의(Task/TaskSequence)는 **실행되면** `TaskHistory` 레코드로 인스턴스화된다. (`runTaskDef` / `runSequence`)

### TaskType (`task.schema.ts:4`)
`MOVE`(이동) · `PROCESS`(구호) · `SUPPLY`(공급) · `CHARGE`(충전) · `RECALL`(복귀=초기위치) · `PAUSE`(일시정지)

### TaskStatus (`task.schema.ts:13`)
`DRAFT`(등록만) → `PENDING` → `ASSIGNED` → `RUNNING` → `COMPLETED` / `FAILED`, 그리고 `SUSPENDED`(관제 조치 대기, PAUSE 보류)

### RobotStatus (`robot/robot.schema.ts:4`) — 상태 DB 단일 작성자 = `RobotService.updateStatus`
- 공통: `IDLE` · `RETURNING` · `PAUSED` · `ERROR`(전복) · `OFFLINE`
- 터틀봇 작업: `MOVING` · `RELIEF`(PROCESS) · `TO_CHARGE` · `CHARGING` · `WAITING_CHARGE`(충전소 만석→초기위치 대기)
- vicpinky 캐리어: `PARKED` · `TO_LOAD` · `LOADING` · `LOADED` · `UNLOADING` · `CARRIER_UP` · `CARRIER_DOWN`
- `online = status !== OFFLINE` (백엔드가 관리, 프론트는 표시만)

### RosStep — "ROS 출력 한 스텝" (`task.schema.ts:33`)
dispatch 시점에 미리 계산해 `TaskHistory.rosPlan[]` 에 저장하고, `rosCursor` 로 한 스텝씩 진행한다.
- `kind`: `move`(노드 주행) | `service`(서비스 호출) | `action`(액션) | `topic`(토픽 발행) | `wait`(시간 대기) | (구버전 `supply`)
- 완료조건: move=노드 도착 / service=응답 / action=result / topic=즉시 / wait=`waitMs` / signal=`awaitTopic` 신호
- `endTopic/endField/endValue`: 기본 완료 후 **추가 외부 신호**가 와야 다음 스텝으로 진행
- `{robot}` 토큰은 실행 시 실제 로봇 id 로 치환

---

## 2. 파일 지도 (현재 구조)

배치 원칙: **결합 0(순수 스토어/유틸)은 최상위 `fms-*` 폴더로**, **결합 있는 로직은 `fms/`** 에 둔다.

```
src/
├─ fms/                         # FMS 핵심 (결합 있는 로직)
│  ├─ task-manager.service.ts   # ★ 오케스트레이터(파사드) + 2초 상태 tick + 외부 API
│  ├─ fms.controller.ts         # HTTP API (/api/fms/*)
│  ├─ fms.module.ts             # DI 배선
│  ├─ task.schema.ts            # TaskHistory(fms_tasks) + RosStep + TaskType/TaskStatus
│  ├─ task.dto.ts               # CreateTaskDto
│  ├─ task-repository.service.ts# DB CRUD/조회/목록 (상태전이 제외)
│  ├─ task-status.service.ts    # 상태 전이(ASSIGNED/RUNNING/returnToQueue…) + 브로드캐스트
│  ├─ dispatch.service.ts       # ★ 수동 배차 + 태스크 타입별 분기 + SUPPLY 대기/타임아웃
│  ├─ task-execution.service.ts # ★ ROS 발행/스텝엔진(rosPlan/cursor)/도착감지/completeTask
│  ├─ node-lock.service.ts      # 노드 잠금 (TopologyService 래퍼)
│  ├─ global-task-queue.service.ts # 태스크 생성 façade(enqueue/register/batch/scenario) + 로봇랭킹
│  ├─ charging.service.ts       # 충전소 점유 "조회 전용"(선택 로직 없음)
│  ├─ robot-monitor.service.ts  # ★ 텔레메트리 라우팅 + 온/오프라인·충전·전복·저배터리
│  ├─ auto-dispatcher.service.ts# 자동 배정 (on/off)
│  ├─ auto-task.service.ts      # ROS 신호→태스크 자동 생성 규칙엔진 (현재 활성 규칙 0)
│  ├─ auto-charger.service.ts   # 자동 충전 reconcile (on/off)
│  ├─ robot-priority.ts         # 로봇 적합도 비교(순수 함수)
│  └─ task-priority.ts          # 태스크 우선순위 비교(순수 함수)
├─ fms-shared/                  # 결합 0: 타입·상수·헬퍼
│  ├─ task-manager.types.ts     #   TaskManagerAlert, RobotCache
│  ├─ task-manager.constants.ts #   임계값/타임아웃 상수
│  └─ task-manager.helpers.ts   #   emptyCache, isTerminalStatus, getPath
├─ fms-state/                   # 결합 0: 런타임 인메모리 스토어
│  ├─ robot-state.service.ts    #   cache/home/online Map (휘발성 상태 단일 owner)
│  └─ robot-task-queue.service.ts # 로봇별 순차 실행(active Map + dispatchNext/advanceScenario)
├─ fms-events/                  # 결합 0: 관제 알림
│  ├─ task-manager-events.service.ts # Socket.IO 서버 핸들 + emit/broadcast
│  └─ alert.ts                  #   Alert 값 객체(의미별 팩토리)
├─ task-catalog/                # 정의 계층 (Task/TaskSequence 저장·로드)
│  ├─ task-catalog.{service,controller,module,schema}.ts
├─ core-events/                 # 인프로세스 이벤트버스(CoreEventBus) — Map→FMS 단방향
└─ common/battery.ts            # 배터리% 정규화/검증 순수 헬퍼
```

---

## 3. 서비스 책임 & 의존 방향 (순환 없음)

```
TaskManagerService (facade)
  ├─ GlobalTaskQueueService   (생성: enqueue/register/batch/scenario, 로봇랭킹)
  ├─ DispatchService          (배차 + 타입별 분기) ──▶ TaskExecutionService (ROS 스텝엔진)
  ├─ RobotMonitorService      (텔레메트리→상태) ──▶ TaskExecution.onAmclPose / completeTask
  ├─ AutoDispatcher / AutoCharger / AutoTask  (자동화 토글)
  ├─ TaskStatusService (상태전이)  /  TaskRepositoryService (CRUD)
  ├─ RobotTaskQueueService (로봇별 순차) ──▶ DispatchService (지연 require로 순환 회피)
  ├─ NodeLockService → TopologyService
  └─ leaf: TaskManagerEventsService, RobotStateService, ChargingService
```
> `robot-task-queue` ↔ `dispatch` 순환은 `ModuleRef` + 런타임 `require`로 끊는다(`robot-task-queue.service.ts:56`).

---

## 4. 실행 흐름 (생성 → 배정 → 주행 → 완료)

```
[생성] enqueue(PENDING) / register(DRAFT) / enqueueBatch / enqueueScenario / runTaskDef / runSequence
         │   (글로벌 큐 = Mongo의 PENDING/DRAFT 문서 집합. 인메모리 리스트 아님)
         ▼
[배정] dispatchTask(taskId)                       # 수동(사용자) 또는 autoDispatcher가 호출
         │ preferredRobotId 검증(온라인/비busy/비ERROR) → 타입별 핸들러
         ▼
[경로] handleNav: resolvePath → pathfinding.findPath → buildRosPlan(goal_pose/nav action 스텝들)
         │ targetNode 잠금(nodeLock) · 로봇 MOVING/RELIEF/TO_CHARGE/RETURNING · ASSIGNED
         ▼
[실행] exec.startPlan → rosPlan[0] 발행 (rosCursor=0, DB 저장, RUNNING)
         │
         ├─ 실 TB3(tb3*): navigate_to_pose 액션 → onNavResult(status=3 도착 / 4 실패)
         └─ TEST/기타: goal_pose 발행 → amcl_pose → checkWaypointArrival(거리 임계)
         ▼
[진행] 중간 노드 도착 → advance(rosCursor++) → 다음 스텝 발행
[완료] 최종 노드 도착 → completeTask → COMPLETED
         │ 도착 노드가 CHARGER면 로봇 CHARGING(+잠금 유지), 아니면 IDLE(+잠금/점유 해제)
         ▼
[다음] robotTasks.dispatchNext(로봇별 FIFO 다음) + advanceScenario(시나리오 다음 스텝)
        (repeat 연속이면 전 스텝 COMPLETED 시 restartRepeatCycle 로 재시작)
```

---

## 5. 큐 모델 — 글로벌 vs 로봇별

**인메모리 리스트 큐는 없다.** 두 "큐"는 모두 Mongo `TaskHistory` 의 `status` 투영이다.

| | 글로벌 큐 | 로봇별 큐 |
|---|---|---|
| 담당 | `GlobalTaskQueueService` (생성 façade) | `RobotTaskQueueService` (`fms-state`) |
| 실체 | `status ∈ {DRAFT,PENDING}` 인 문서 집합(Mongo) | 인메모리 `active: Map<robotId,taskId>`(실행 1개) + `preferredRobotId=robot && PENDING` 문서 |
| 추가 | enqueue/register/batch/scenario | PENDING + `preferredRobotId` 로 생성되면 자동 편입 |
| 꺼냄 | 외부(`dispatchTask`/autoDispatcher) | `dispatchNext` 가 **FIFO**(`seq↑, createdAt↑`) |
| 정렬 | autoDispatcher가 읽을 때 **task-priority** 적용 | seq/createdAt |

**배정 경로 3가지:** ① 수동 `dispatchTask` ② 자동 `autoDispatcher`(task-priority로 태스크 선택 + robot-priority로 로봇 선택) ③ 순차 `dispatchNext`/`advanceScenario`(같은 로봇 FIFO / 시나리오 핸드오프).

---

## 6. 태스크 타입별 처리 (`dispatch.service.ts`)

분기: `task.rosPlan` 이 있으면(커스텀, preempt 타입 제외) → `handleCustomPlan`(경로계산 없이 저장 스텝 그대로 실행). 아니면 타입별:

| 타입 | 핸들러 | ROS 출력 | 완료 / 실패 | 로봇 상태 |
|---|---|---|---|---|
| **MOVE** (기본) | `handleNav` | goal_pose / nav action | 최종 노드 도착→`completeTask` | `MOVING` |
| **PROCESS** | `handleNav` | 동일 | 동일 | `RELIEF` |
| **CHARGE** | `handleNav` | 동일 | 도착 노드가 CHARGER면 `CHARGING`(태스크는 COMPLETED) ⚠️ §11 | `TO_CHARGE` |
| **RECALL** | `handleRecall`→`handleNav` | 보유태스크 큐 반납 후 맵 `initPosition` 노드로 이동 | 도착(또는 이미 도착)→COMPLETED+IDLE / initPosition 없으면 FAILED | `RETURNING` |
| **SUPPLY** | `handleSupply` | `/omx/vision/start_inference` `std_msgs/msg/Bool{data:true}` | `/omx/vision/is_loaded`=true→`onSupplyLoaded`(COMPLETED) / 30s(`SUPPLY_TIMEOUT_MS`) 타임아웃→FAILED | `LOADING` |
| **PAUSE** (preempt) | `handlePause` | `cancelNav`+`hardStop`(cmd_vel=0) | 보유 태스크 `SUSPENDED`, PAUSE 자신 즉시 COMPLETED. 재개=`resumeTask`→`resumePlan` | `PAUSED` |
| **커스텀** | `handleCustomPlan` | 저장 스텝(move/service/action/topic/wait/signal) | 스텝별 완료, 마지막 스텝→완료 | 타입별 |

`movingStatusFor`: CHARGE→`TO_CHARGE`, PROCESS→`RELIEF`, RECALL→`RETURNING`, else `MOVING`.

---

## 7. 도착 / 완료 감지 (`task-execution.service.ts`)

- **실 TB3(`robotId.startsWith('tb3')`)**: `navigate_to_pose` 액션 결과 — `status===3`(SUCCEEDED) 도착 / `===4`(ABORTED) 실패. amcl 임계 미사용.
- **TEST/기타 봇**: `goal_pose` 발행 + `amcl_pose` 거리 임계(`checkWaypointArrival`). 재진입 가드(`waypointProcessing`).
- **적응형 도착 임계**(`computeArrivalThreshold`): `TEST*`→`TEST_ARRIVE_M(0.05)` / 최종노드→`NODE_ARRIVE_M(0.5)` / 중간노드→`min(NODE_PASS_M 1.5, max(0.15, segLen*0.15))`.
- `completeTask`: active 해제 → COMPLETED → (CHARGER면 CHARGING+잠금유지, 아니면 IDLE+잠금/점유해제) → `Alert.completed` → `dispatchNext`+`advanceScenario`.

---

## 8. 자동화 (토글 3종) — 모두 2초 tick이 pull

| 토글 | 서비스 | 동작 | 비고 |
|---|---|---|---|
| **auto-dispatch** | `AutoDispatcherService` | `findAutoDispatchable`(단건 DRAFT/PENDING, task-priority순) → 각 태스크에 robot-priority 최상위 가용로봇 배정 | **SUPPLY=omx 전용, 그 외 omx 제외**. RECALL/PAUSE는 preempt 즉시. setAutoDispatch가 auto-task도 함께 on/off |
| **auto-task** | `AutoTaskService` | ROS 신호(트리거 토픽) 매칭 시 태스크 자동 **생성**(enqueue/register) | 정의(`Task.triggerTopic`) 기반. **현재 활성 규칙 0**(예제 2개 주석). 쿨다운 `DEFAULT_COOLDOWN_MS=30s` |
| **auto-charge** | `AutoChargerService` | 저배터리 로봇을 가장 가까운 빈 충전소로 `CHARGE` 배차; 만석이면 초기위치 `WAITING_CHARGE`; 충전완료(≥80%)면 초기위치로 퇴거해 충전소 비움 | 트리거=`monitor.needsCharge`(래치). `isDrivable`=omx/vicpinky 제외. 진행 작업은 선점 안 함 |

> **충전소 선택 로직은 `AutoChargerService.nearestCharger`** (hop 거리 최소)에 있다. `ChargingService` 는 점유 **조회 전용**(자동 선택/예약/대기큐 모두 제거됨).

---

## 9. 우선순위 (순수 함수)

**robot-priority.ts — 사전식 비교(가중치 없음)**, `BATTERY_OK_PCT=40`
- 1순위(전 타입): 온라인 우선
- CHARGE: 2)`!busy` → 3)배터리 **오름차순**(낮을수록 먼저=가장 급함)
- 그 외(MOVE/PROCESS/SUPPLY): 2)`!busy` → 3)배터리 `≥40` 우선 → 4)거리 **오름차순**

**task-priority.ts — 2키 내림차순**
- 키1 `STATUS_RANK`: `DRAFT 5 > PENDING/ASSIGNED 4 > RUNNING/SUSPENDED 3 > COMPLETED 2 > FAILED 1`
- 키2 `TYPE_PRIORITY`: `RECALL/PAUSE 20 > PROCESS 10 > MOVE/SUPPLY 5 > CHARGE 1`

---

## 10. 로봇 상태 전이 — 누가 설정하나

| 상태 | 설정 주체 |
|---|---|
| `MOVING/RELIEF/TO_CHARGE/RETURNING` | `dispatch.handleNav`(`movingStatusFor`) |
| `LOADING` | `dispatch.handleSupply` / `PAUSED`=`handlePause` |
| `CHARGING` | `exec.completeTask`(CHARGER 도착) / `monitor.reconcileChargingStatus`(battery_state) |
| `WAITING_CHARGE` | `autoCharger.sendToWaitCharge`(충전소 만석) |
| `ERROR` | `monitor.onImu`(roll/pitch>45°) — 복구 시 IDLE |
| `OFFLINE` | `monitor`(6초 무수신) — 복귀 시 online |
| `IDLE` | 완료/취소/정지/맵변경/충전완료/온라인복귀 등 다수 |

**텔레메트리 라우팅**(`monitor.handle`): 임의 토픽→`lastSeen`(단, cmd_vel/goal_pose/initialpose/speak_cmd/joint_commands 제외) · `battery_state`→`batteryPct`/`charging` · `amcl_pose`→위치캐시+`exec.onAmclPose` · `imu`→`onImu`.

---

## 11. 충전 "요/불필요" 로직

> 충전 요/불필요는 **태스크 성공·실패가 정하지 않는다.** 독립적인 **배터리 임계 모니터(2초)** 가 판단한다.

- **충전 요**(`checkLowBattery`): 온라인+비충전+배터리 `< LOW_BATTERY_PCT(20)` → `Alert.lowBattery`(에피소드당 1회 래치). `needsCharge()` 래치가 auto-charge 트리거.
- **충전 완료/불필요**(`reconcileChargingStatus`, 진행 태스크 없을 때만): CHARGING+배터리 `≥ CHARGE_TARGET_PCT(80)` → IDLE. 명시적 방전(power_supply_status=2)도 CHARGING→IDLE. 회복 시 `Alert.charged`.

### ⚠️ CHARGE 태스크의 미완성 라이프사이클
- CHARGE 전용 핸들러가 없고 `handleNav` 로 흐른다. 충전소 도착 시 로봇만 `CHARGING` 으로 바뀌고 **태스크는 즉시 COMPLETED + `dispatchNext`/`advanceScenario` 발화**(실제 충전 세션/언도크 없음).
- 수동 CHARGE 는 **목적지(충전소 노드) 해석 단계가 없어** `targetNode=''` → `findNodeById('')`=null → **FAILED** 가능(`task.md` §2). auto-charge 경로는 `nearestCharger` 로 목적지를 채워 정상.

---

## 12. 이벤트 / 알림

**Alert 팩토리(`alert.ts`)** → `events.emit` 이 `id`+`timestamp` 붙여 `task_manager_alert` 소켓 발행:

| 팩토리 | type | requiresAction |
|---|---|---|
| `info` | info | false |
| `assigned` / `completed` / `charged` | 동명 | false |
| `noPath` / `fall` / `robotOffline` / `lowBattery` | no_path/fall/robot_offline/low_battery | **true** |

기타 소켓 브로드캐스트: `robot_status_changed{robot_id,status}` · `robot_registered` · `fms_task_created/updated/deleted` · `fms_tasks`(전체목록).
**소비자**: Socket.IO 서버는 `gateway/ros.gateway.ts`(`afterInit`→`taskManager.setServer`)가 주입 → 전부 **프론트(WebSocket)** 로 나간다. 백엔드 내부 소비자는 없음.
**CoreEventBus**(별개, 소켓 아님): `ROBOT_MAP_REASSIGNED`(map.service→`task-manager.handleMapChange`)만 사용.

---

## 13. 상수표 (`fms-shared/task-manager.constants.ts`, env 조정 가능)

| 상수 | 값 | 용도 |
|---|---|---|
| `STATUS_REFRESH_MS` | 2000 | 상태 tick 주기(task-manager.service.ts) |
| `ONLINE_MS` | 5000 | (온라인 표기) |
| `OFFLINE_AFTER_MS` | 6000 | 무수신 오프라인 판정 |
| `FALL_THRESH_RAD` | π/4 (45°) | 전복 판정 |
| `NODE_PASS_M` / `NODE_ARRIVE_M` / `TEST_ARRIVE_M` | 1.5 / 0.5 / 0.05 | 통과/도착/테스트봇 임계(m) |
| `CHARGE_TARGET_PCT` / `LOW_BATTERY_PCT` | 80 / 20 | 충전 완료 / 저배터리 하한(%) |
| `BATTERY_OK_PCT` | 40 | robot-priority 배터리 양호선 |
| `SUPPLY_TIMEOUT_MS` | 30000 | 공급 비전 적재 타임아웃 |
| `DEFAULT_COOLDOWN_MS` | 30000 | auto-task 규칙 쿨다운 |
| ~~`LOOP_MS` 1000 / `AMCL_TIMEOUT_MS` 60000 / `AMCL_RESUME_MS` 30000~~ | — | **현재 미사용(데드)** |

---

## 14. HTTP API 표면 (`fms.controller.ts`, prefix `/api/fms`)

| 메서드·경로 | 동작 |
|---|---|
| `GET tasks` / `tasks/:id` | 목록(status/robot_id/limit/sort/afterMs) / 단건 |
| `GET tasks/:id/robot-ranking` / `robot-ranking` | 태스크별 / 목적지별 로봇 추천 |
| `POST tasks` | 생성 — `draft`면 DRAFT(register) 아니면 PENDING(enqueue) |
| `POST tasks/batch` / `tasks/scenario` | 연속(batchId) / 시나리오(scenarioId) 등록·실행 |
| `POST sequences/:id/run` / `task-defs/:id/run` | 저장 시나리오 / 단일 정의 실행 |
| `POST tasks/:id/dispatch` | 수동 배차(body.robotId면 지정+PENDING) |
| `POST tasks/:id/resume` / `tasks/batch/:batchId/stop` | 재개 / 반복연속 정지 |
| `DELETE tasks/:id/cancel` / `tasks/:id` / `queue` / `tasks` | 취소 / 삭제 / 글로벌큐비움 / 전체초기화 |
| `GET·POST auto-dispatch` / `auto-charge` / `auto-task` | 자동화 토글 조회·설정 |

> AI 태스크 생성/대화는 `AiController`(`/ai/*`)가 담당 — FMS는 AI에 의존하지 않음.

---

## 15. 알려진 공백 / 데드코드 (동작엔 대체로 무해)

- **CHARGE 라이프사이클 미완성** — §11. 충전소 노드 해석 단계만 추가하면 연결(RECALL의 `initPosition` 해석 패턴 동일).
- **`buildRosPlan` 의 SUPPLY 분기는 죽은 코드** — SUPPLY는 `handleSupply`가 먼저 가로채므로 도달 불가. 실제 공급은 `start_inference`/`is_loaded`로 처리.
- **`awaitKind:'vision_loaded'` 소비자 없음** — 스텝엔진은 `'arrival'`만 특수처리. (죽은 SUPPLY 분기에서만 생성)
- **`alert.ts` `task_failed` 타입에 팩토리 없음** — 선언만 있고 발행 안 됨(실패는 info/no_path로 표면화).
- **AMCL 일시정지 미배선** — `RobotCache.amclSuspended`/`lastAmclMs` 존재, 모니터가 `lastAmclMs`를 쓰기만 하고 읽지 않음. `AMCL_TIMEOUT/RESUME` 상수도 데드.
- **`auto-dispatcher`의 `robotTasks` 주입 미사용 / `robot-state.setCache` 미사용** — 데드 주입/메서드.
- **stale 주석**: 전복 "30s 쿨다운" 주석 ↔ 실제는 자세복구 래치. `web_back/FMS_LOGIC_MAP.md` 전체가 옛 폴더구조 기준.

---

## 16. 검증 (e2e)

로컬 MongoDB + 백엔드 내장 **가상 테스트봇**(`TEST-BOT*`)으로 전체 파이프라인 end-to-end 검증.
- `test/fms-pipeline.e2e-spec.ts` (+ `charging`/`custom-step`/`nav-action`/`sequence-run`/`signal-step`/`task-catalog`/`victim` e2e).
- 실행: `npm run test:e2e -- fms-pipeline` (MongoDB 필요). 시나리오: 온라인 인식 → 경로탐색·할당·주행·완료 → 로봇별 큐잉(순차 실행 증명).
