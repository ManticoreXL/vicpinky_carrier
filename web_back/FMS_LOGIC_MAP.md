# FMS_LOGIC_MAP

`web_back` 백엔드의 FMS(Fleet Management System) 로직 지도.
거대한 단일 파일(`task-manager.service.ts` 980줄)을 **역할별 주입형(NestJS) 서비스**로
분리하고, `src/` 폴더 구조를 도메인별로 재정리한 결과를 정리한다.

---

## 1. 한눈에 보는 핵심 로직 → 파일 매핑

| 핵심 로직 | 담당 | 위치 |
|---|---|---|
| **경로 탐색**(Dijkstra) | `PathfindingService` | `src/pathfinding/pathfinding.service.ts` |
| **경로 탐색이 실행되는 곳**(할당 루프) | `DispatchService` | `src/fms/dispatch/dispatch.service.ts` |
| **task 타입별 로직** | `SupplyTaskHandler` / `NavigationTaskHandler` | `src/fms/dispatch/task-handlers/` |
| **글로벌 task queue** | `GlobalTaskQueueService` | `src/fms/queue/global-task-queue.service.ts` |
| **로봇별 task queue** | `RobotTaskQueueService` | `src/fms-state/robot-task-queue.service.ts` (결합 0 → 최상위) |
| **노드 잠금 + 우회 재경로** | `NodeLockService` | `src/fms/node-lock/node-lock.service.ts` |
| 경로 주행 실행(웨이포인트/코너) | `NavigationService` | `src/fms/navigation/navigation.service.ts` |
| AMCL/Nav2 복구 | `NavRecoveryService` | `src/fms/navigation/nav-recovery.service.ts` |
| 전복(IMU) 감지 | `FallDetectionService` | `src/fms/monitor/fall-detection.service.ts` |
| 온라인/오프라인 생명주기 | `RobotMonitorService` | `src/fms/monitor/robot-monitor.service.ts` |
| ROS 메시지 라우팅 | `RobotTelemetryService` | `src/fms/monitor/robot-telemetry.service.ts` |
| 오케스트레이터(파사드) + tick | `TaskManagerService` | `src/fms/task-manager.service.ts` |

---

## 2. 폴더 구조 (재정리 후)

배치 원칙: **결합 없는(의존성 0) 순수 스토어/유틸은 `src/` 최상위로**,
**결합 있는 로직은 도메인 폴더 안에** 둔다. (pathfinding이 순수 알고리즘이라 최상위로
빠진 것과 동일한 기준)

```
src/
├─ fleet.module.ts           # robot/topology/pathfinding/telemetry/collision/occupancy 집합 모듈
├─ robot/                    # 로봇 등록·상태 (DB)
│  ├─ robot.service.ts  robot.controller.ts  robot.schema.ts
├─ topology/                 # 노드·엣지 그래프 (CRUD + 노드 잠금)
│  ├─ topology.service.ts  topology.controller.ts  node.schema.ts  edge.schema.ts
├─ pathfinding/              # 경로 탐색(Dijkstra) — 순수 알고리즘(결합 0)
│  └─ pathfinding.service.ts
├─ geometry/                 # 기하 값 객체(결합 0): Quaternion·Pose·normalizeAngle
│  └─ pose.ts                #   쿼터니언↔yaw/roll/pitch, 거리/방위 (중복 제거용)
├─ telemetry/                # ROS 텔레메트리 → DB 반영
├─ collision-avoidance/      # 2-ahead 노드 충돌 판정(순수 의사결정)
├─ node-occupancy/           # 노드 점유 인메모리 추적
│
│  # ── 결합 0짜리 FMS 부품: 폴더 밖(최상위)으로 추출. 이름에 fms- 접두로 소속을 명시 ──
├─ fms-shared/               # FMS 공용 타입·유틸·상수 (의존성 0)
│  └─ task-manager.types.ts  task-manager.helpers.ts  task-manager.constants.ts
├─ fms-state/                # FMS 런타임 인메모리 스토어 (의존성 0)
│  ├─ robot-state.service.ts        # 로봇별 상태(캐시/홈/온라인)
│  ├─ robot-task-queue.service.ts   # 로봇별 큐(활성 1 + 대기 FIFO)
│  └─ rotation-state.service.ts     # 코너 회전 상태
├─ fms-events/               # FMS 관제 알림(emit) — socket 서버 핸들 (의존성 0)
│  ├─ task-manager-events.service.ts
│  └─ alert.ts               #   Alert 값 객체: 의미별 팩토리(assigned/completed/fall/…)
│
├─ map/                      # 맵 도메인 (live SLAM 맵 + 논리 맵 정의)
│  ├─ map.service.ts  map.controller.ts  map.module.ts       # 실시간 점유격자/SLAM PNG·할당
│  └─ fleet-map.service.ts  fleet-map.controller.ts  fleet-map.schema.ts  # 맵 정의·초기위치 레지스트리
├─ ros/                      # rosbridge 연동
│  ├─ ros.service.ts  ros.module.ts  ros.types.ts
│  ├─ domain-bridge/         # tb3/omx 토픽 도메인 브리지(별도 폴더로 분리)
│  └─ virtual-robot/         # 백엔드 내장 가상 테스트봇 시뮬레이터
│
└─ fms/                      # ── FMS 핵심: '결합 있는' 로직만 폴더로 그룹화 ──
   ├─ fms.module.ts  fms.controller.ts  fms.service.ts  task.schema.ts
   ├─ task-manager.service.ts          # 파사드(외부 API + tick 루프)
   ├─ queue/
   │  └─ global-task-queue.service.ts  # 글로벌 큐(미배정 PENDING) — FmsService/Mongo 결합
   ├─ dispatch/
   │  ├─ dispatch.service.ts           # 할당 루프 + dispatchNext
   │  └─ task-handlers/                # task 타입별 실행 전략
   │     ├─ task-handler.interface.ts
   │     ├─ supply-task.handler.ts     # SUPPLY: 즉시 보급
   │     └─ navigation-task.handler.ts # MOVE/PROCESS/CHARGE: 경로탐색+주행착수
   ├─ navigation/
   │  ├─ navigation.service.ts         # 웨이포인트 도달/코너 회전/충돌 적용
   │  ├─ nav-goal.service.ts           # goal_pose/정지/홈복귀 발행 (leaf, FmsService 결합)
   │  └─ nav-recovery.service.ts       # AMCL 타임아웃→SUSPEND, 복구→재개
   ├─ node-lock/node-lock.service.ts   # 노드 잠금 + 경유 로봇 우회 재경로
   └─ monitor/
      ├─ robot-monitor.service.ts      # 온라인/오프라인 + 재시작 복구
      ├─ robot-telemetry.service.ts    # ROS 메시지 분류·라우팅
      └─ fall-detection.service.ts     # IMU 전복 감지·복구
```

> 참고:
> - `fleet/` 하위 도메인은 모두 `src/` 최상위로 끌어올렸고, 헷갈리던 `fleet-map`은 `map/`으로 합쳤다.
> - `fms/` 안에서도 **결합 0인 부품**(`fms-shared`·`fms-state`·`fms-events`)은 최상위로 빼고, **결합 있는**
>   로직만 폴더로 남겼다. 단, 파일 위치만 옮겼을 뿐 이들은 여전히 `FmsModule`의 provider다
>   (pathfinding이 `src/pathfinding/`에 있어도 `FleetModule` provider인 것과 같은 패턴).
> - `queue`가 둘로 나뉜 이유: `global-task-queue`는 Mongo/`FmsService`에 결합 → `fms/queue/`,
>   `robot-task-queue`는 순수 인메모리 → `fms-state/`.
> - **객체화(값 객체)**: 여러 곳에 흩어져 중복되던 데이터+행위는 값 객체로 캡슐화했다.
>   `geometry/pose.ts`의 `Quaternion`(쿼터니언↔yaw/roll/pitch)·`Pose`(거리/방위)로
>   쿼터니언 변환 중복(4곳)과 orientation 리터럴(3곳)을 통합하고, `fms-events/alert.ts`의
>   `Alert` 팩토리로 관제 알림 리터럴(13곳)을 통합했다. 반면 순수 데이터 레코드
>   (`RobotCache`·`CollisionDecision`·`RotatingState` 등)는 행위가 없어 interface로 둔다.

---

## 3. 전체 흐름

### 3.1 tick 루프 (`TaskManagerService.tick`, 1s 주기)
```
monitor.syncOnlineStatus()      # 캐시 lastSeen 기반 온라인↔오프라인 전환
navRecovery.checkAmclTimeout()  # amcl_pose 60s 끊김 → 태스크 SUSPEND
dispatch.process()              # 글로벌 큐 → 로봇 배정
navigation.checkNodeConflicts() # 2-ahead 노드 충돌 정지/재출발
```

### 3.2 ROS 메시지 (이벤트 기반, `RobotTelemetryService`)
```
ROS /<bot>/*        → robotState.lastSeen 갱신
   /<bot>/battery_state → robotState.batteryPct
   /<bot>/amcl_pose     → robotState 위치 갱신 → NavigationService.onAmclPose()
   /<bot>/imu           → FallDetectionService.onImu()
```

### 3.3 할당 → 주행 → 완료 (해피패스)
```
enqueue(task)                         # 글로벌 큐 PENDING
  └ dispatch.process (다음 tick)
      ├ 가용 IDLE 로봇 수집
      ├ NavigationTaskHandler.handle
      │    ├ PathfindingService.findPath  (출발=robot.location/AMCL최근접)
      │    ├ robotTasks.setActive / DB ASSIGNED / robot MOVING / 목적지 노드 잠금
      │    └ navGoal.sendNodeActionGoal(첫 노드)
      └ (가상/실제 로봇 이동) → amcl_pose
           └ NavigationService.checkWaypointArrival
                ├ 중간 노드: 큐 shift → 다음 노드 goal (필요 시 코너 정지·회전)
                └ 최종 노드: DB COMPLETED / robot IDLE / 노드 잠금 해제 / 점유 해제
                     └ dispatch.dispatchNext(robot)  # 로봇 큐 다음 태스크, 없으면 홈복귀
```

---

## 4. 글로벌 큐 vs 로봇별 큐 (핵심 동작)

- **글로벌 큐**(`GlobalTaskQueueService`) = 아직 **어느 로봇에도 배정되지 않은** PENDING 태스크.
  영속 저장은 Mongo(`FmsService`), 우선순위 정렬은 `priority ASC, createdAt ASC`.
- **로봇별 큐**(`RobotTaskQueueService`) = **특정 로봇에 커밋된** 태스크.
  - `active: robotId → taskId` (실행 중, 로봇당 1개)
  - `queued: robotId → taskId[]` (대기 FIFO)

할당 정책(`DispatchService.process`):

| 상황 | 처리 |
|---|---|
| `preferredRobotId` 지정 + 그 로봇 가용 | 즉시 배정 |
| `preferredRobotId` 지정 + 그 로봇 작업 중(온라인) | **로봇별 큐에 적재** (태스크 ASSIGNED + `대기열 N번`) |
| `preferredRobotId` 지정 + 오프라인 | 글로벌 큐 유지(`지정 로봇 대기`) |
| 지정 없음 + 가용 로봇 있음 | 임의 IDLE 로봇 배정 |
| 지정 없음 + 가용 로봇 없음 | 글로벌 큐 유지 |

로봇이 활성 태스크를 끝내면(`completeTask`/취소/reconcile) `dispatchNext(robotId)`가
로봇별 큐의 다음 태스크를 꺼내 실행한다(SUPPLY는 즉시완료이므로 건너뛰고 다음 시도).
로봇이 **오프라인**되면 그 로봇의 대기 태스크는 글로벌 큐로 **반환(재할당)**된다.

---

## 5. 의존성 계층 (순환 없음, DAG)

순환 의존을 피하려고 공용 기능을 **leaf 서비스**로 분리했다:
`nav-goal`(goal 전송), `rotation-state`, `robot-state`, `task-manager-events`.

```
TaskManagerService (facade)
  ├─ RobotMonitorService ── NavigationService, NodeLock, leaves
  ├─ NavigationService ──── DispatchService, NodeLockService, NavRecoveryService, NavGoalService(leaf)
  ├─ DispatchService ────── Navigation/SupplyTaskHandler, queues
  │     └ NavigationTaskHandler ── NodeLockService, NavGoalService, Pathfinding
  ├─ NodeLockService ────── NavGoalService(leaf), Pathfinding
  └─ NavGoalService(leaf) ── Fms, Topology, RobotState, Events
```
모든 화살표가 leaf 방향으로만 향한다 → `forwardRef` 불필요.

---

## 6. 노드 잠금 / 우회 (`NodeLockService.lockNode`)

1. `TopologyService.setNodeLocked()` — DB 잠금 + `node_lock_changed` 브로드캐스트
2. 잠긴 노드를 **경유 중인 모든 활성 로봇**에 대해:
   - 현재 위치(robot.location 또는 AMCL 최근접) → 목적지 `Pathfinding.findPath` 재계산
   - 우회 경로 있으면 `updatePathQueue` + 첫 노드 `sendNodeActionGoal`
   - 우회 불가면 정지 + `waitReason`
- 전복 감지 시 `FallDetectionService`가 전복 지점 노드를 자동으로 잠가 다른 로봇이 우회한다.

---

## 7. 외부 공개 API (불변)

`TaskManagerService`는 파사드로 남아 게이트웨이/컨트롤러/AI가 쓰던 API를 그대로 유지한다:
`setServer`, `enqueue`, `register`, `releaseTask`, `cancelTask`, `lockNode`,
`getLockedNodeIds`, `setHomePosition`, `setInitialPoseAndLocation`, `handleMapChange`,
`stopRobot`, `returnHomeNow`, `ackAlert`.

---

## 8. 검증 (verification)

로컬 MongoDB + 백엔드 내장 **가상 테스트봇**(`TEST-BOT1`)으로 전체 파이프라인을
end-to-end 검증했다. 위치: `test/fms-pipeline.e2e-spec.ts`.

```
npm run test:e2e -- fms-pipeline      # 실행 (MongoDB 필요)
```

검증 시나리오(3개 모두 통과):
1. 가상 테스트봇 온라인 인식
2. **경로탐색 → 할당 → 주행 → 완료** (`N1→N2→N3`, fullPath=`[N2,N3]`, 도착 location=`N3`)
3. **로봇별 큐잉**: 작업 중 들어온 2번째 태스크가 큐에 적재되어 1번째 완료 후 순차 실행
   (B.startedAt ≥ A.completedAt 로 병렬 아님 = 큐잉 증명)

추가로 전체 `AppModule` 부팅 + DI 해석을 스모크 테스트해 재정리 후 모듈 배선을 확인했다.
(`nest build` 성공, 기존 단위 테스트 통과)
```
mongod                         # 실행 중이어야 함 (기본 ros_dashboard, 검증은 fms_verify DB 사용)
```
