# TASK ↔ ROS 연결 / 로봇 상태 전이 / 충전 로직 점검

> 작성 기준: 현재 코드 점검 결과. 코드 수정 없음(점검·문서화 only).

---

## 1. 공통 ROS 배관 (모든 태스크 공유)

- **발행(다운링크)**: `TaskExecutionService` / `DispatchService`
  → `RosService.publish()` (`ros/ros.service.ts:144`)
  → rosbridge WebSocket
  → **`ros_packages/domain_bridge/domain_bridge_*.yaml`** (허브 도메인 49 ↔ 로봇 도메인)
  → 로봇
- **수신(업링크)**: rosbridge → `RosService.onMessage` 핸들러들
  (`RobotMonitorService`, `TelemetryService`, gateway). 구독 목록 = `ros/ros.types.ts:SUBSCRIBED_TOPICS`
- **테스트봇(TEST-BOT\*)**: `VirtualRobotService`가
  - `onPublish`로 goal_pose/cmd_vel/initialpose 발행을 **가로채** 시뮬레이션
  - `injectMessage`로 amcl_pose/odom/battery_state/imu를 **주입** → 실로봇과 동일한 핸들러 경유
- **도메인 브릿지 매핑 확인**: goal_pose·cmd_vel·initialpose(다운), amcl_pose·battery_state·imu(업),
  vision/start_inference·vision/is_loaded(omx) **전부 yaml에 존재** ✓

---

## 2. 태스크별 ROS 연결 점검

| 태스크 | 발행 토픽 / 타입 | 완료 감지 | 관여 파일 | 상태 |
|---|---|---|---|---|
| **MOVE(이동)** | `/{r}/goal_pose` `geometry_msgs/PoseStamped` (경로 노드마다) | `amcl_pose` 도착 → `checkWaypointArrival` → `completeTask`(IDLE) | dispatch, task-execution, robot-monitor, pathfinding, topology | ✅ |
| **PROCESS(구호)** | MOVE와 동일 (주행 상태만 RELIEF) | 동일 | 위와 동일 | ✅ |
| **SUPPLY(공급)** | `/omx/vision/start_inference` `std_msgs/msg/Bool {data:true}` | `/omx/vision/is_loaded`=true → `onSupplyLoaded`(IDLE) / 30s 타임아웃 → FAILED | dispatch(`handleSupply`/`onModuleInit` 구독), ros.types, domain_bridge_omx | ✅ |
| **RECALL(복귀)** | `findInitPositionNode`로 목적지 해석 후 `goal_pose` (상태 RETURNING) | MOVE와 동일 도착 감지 | dispatch(`handleRecall`), task-execution, topology | ✅ |
| **PAUSE(일시정지)** | `/{r}/cmd_vel` `Twist/TwistStamped` 0 (정지) | 즉시 COMPLETED + 진행분 SUSPENDED / 재개=`resumePlan`로 goal_pose 재전송 | dispatch(`handlePause`/`resumeTask`), task-execution(`cmdVelTarget`/`publishStop`/`resumePlan`) | ✅ |
| **CHARGE(충전)** | (목적지 없음) → `goal_pose` … 도착 노드가 CHARGER면 CHARGING, 배터리≥목표→IDLE | task-execution(`completeTask` atCharger), robot-monitor(`reconcileChargingStatus`) | dispatch, task-execution, robot-monitor, charging.service | ⚠️ **미연결** |

### ⚠️ CHARGE만 ROS에 안 닿는 이유
충전 도착·완료(CHARGING→IDLE) **감지 로직은 다 있는데, 목적지(충전소 노드)를 정하는 단계가 없음**:
- 패널 충전 = 로봇 전용(목적지 없음) → `targetNode=''`
- 프론트 `emitFmsAutoCharge(robotId)`가 **`chargerNodeId`를 안 보냄** (`web_front/.../useNestSocket.ts:347`)
- `ChargingService`는 점유 조회만 있고 **충전소 선택 로직 없음**(주석: "자동 최근접 선택… 모두 제거됨")
- 결과: `handleNav` → `resolvePath` → `findNodeById('')`=null → **`목적지 노드 없음`으로 FAILED** (`dispatch.service.ts:221`)

→ RECALL이 `findInitPositionNode`로 목적지를 해석하듯, **충전소 노드를 자동 해석하는 한 단계**만 넣으면 연결됨.

### 메모 (동작엔 무해)
- `buildRosPlan`의 SUPPLY 분기는 **죽은 코드** — 실제 공급은 `handleSupply`→`supplyStart`로 발행.
- **vicpinky/omx는 `amcl_pose` 미구독** → vicpinky 노드 주행 도착 감지 불가(범위 외). omx는 공급 전용이라 무관.
- 메시지 타입 표기 혼용(`std_msgs/Bool` vs `std_msgs/msg/Bool`)은 rosbridge가 관대해 실동작 문제 없음.

---

## 3. 로봇 상태(RobotStatus) 전이

상태 정의: `robot/robot.schema.ts`.
**상태 DB 기록은 단일 작성자** = `RobotService.updateStatus()` (`robot/robot.service.ts:63`, `status` + `online=status!==OFFLINE`).
변경 시 `events.broadcast('robot_status_changed', …)` → 프론트 갱신.

### 상태별 전이 표

| 상태 | 의미 | 누가/언제 설정 | 파일 |
|---|---|---|---|
| **IDLE** | 대기(할당 가능) | 태스크 완료, 공급 완료, 취소/정지/맵변경, ERROR 복구, 충전 완료, 온라인 복귀 | task-execution(`completeTask`), dispatch(`onSupplyLoaded`), task-manager(취소/정지/맵변경), robot-monitor(ERROR복구·충전완료·온라인) |
| **MOVING** | 이동 중 | MOVE 디스패치 / 재개 | dispatch(`handleNav`·`movingStatusFor`) |
| **RELIEF** | 구호 중 | PROCESS 디스패치 | dispatch(`handleNav`) |
| **TO_CHARGE** | 충전소 이동 중 | CHARGE 디스패치 | dispatch(`handleNav`) |
| **RETURNING** | 복귀 중 | RECALL 디스패치 | dispatch(`handleNav`) |
| **LOADING** | 상차/공급 중 | SUPPLY 디스패치 | dispatch(`handleSupply`) |
| **PAUSED** | 일시정지 | PAUSE 디스패치 | dispatch(`handlePause`) |
| **CHARGING** | 충전 중 | 충전소 노드 도착 / battery_state 충전 감지 | task-execution(`completeTask` atCharger), robot-monitor(`reconcileChargingStatus`) |
| **ERROR** | 오류(전복) | IMU roll/pitch>45° 감지 | robot-monitor(`onImu`) |
| **OFFLINE** | 오프라인 | 토픽 미수신(타임아웃) | robot-monitor(`handleOfflineTransition`)→robot.service(`setOffline`) |

### 상태 입력(텔레메트리) 라우팅 — `RobotMonitorService.handle` (`onModuleInit`→`rosService.onMessage`)
- 임의 토픽 → `lastSeen` 갱신(온라인 판정)
- `battery_state` → `cache.batteryPct` / `charging`(power_supply_status)
- `amcl_pose` → 위치 캐시 + `exec.onAmclPose`(도착 판정)
- `imu` → `onImu`(전복 → ERROR)

### 주기 동기화 — `RobotMonitorService.syncOnlineStatus` (2초 간격, `TaskManagerService.onModuleInit`이 구동)
- 온/오프라인 전환
- 진행 태스크 없을 때 `reconcileChargingStatus`(충전 표시 동기화)
- `checkLowBattery`(저배터리 알림)

---

## 4. 태스크 성공 / 실패 처리

### 성공 (COMPLETED)
| 태스크 | 처리 | 다음 |
|---|---|---|
| MOVE/PROCESS/RECALL | 최종 노드 도착 → `completeTask` → **충전소 노드면 CHARGING, 아니면 IDLE** | `dispatchNext`(연속) + `advanceScenario`(시나리오) |
| SUPPLY | `is_loaded`=true → COMPLETED + IDLE | 동일 |
| CHARGE | 충전소 도착 → CHARGING (배터리 채울 때까지 유지, "완료" 아님) | 배터리≥80% → IDLE (4번 항목) |
| PAUSE | 즉시 COMPLETED, 로봇 PAUSED(진행분 SUSPENDED 보류) | 재개 버튼 → `resumeTask` |

### 실패 (FAILED)
| 원인 | 태스크 | 로봇 상태 | 파일 |
|---|---|---|---|
| 경로/목적지 없음 | FAILED + waitReason | (상태 변경 전 단계라) 유지(보통 IDLE) | dispatch(`resolvePath`/`planPath`) |
| 공급 타임아웃(30s) | FAILED | LOADING→그대로(이후 정리 필요) | dispatch(`onSupplyTimeout`) |
| 취소 | FAILED | IDLE | task-manager(`cancelTask`) |
| 맵 변경 | 진행분 FAILED | IDLE | task-manager(`handleMapChange`) |
| 오프라인 | 진행분 FAILED | OFFLINE | robot-monitor(`handleOfflineTransition`) |
| **ERROR(전복)** | 진행 RUNNING → **FAILED + 새 PENDING 재등록**, 그 외 PENDING → **robot_id 초기화해 글로벌 큐 반납** | ERROR | robot-monitor(`handleErrorTransition`) |

---

## 5. 충전 "요 / 불필요" 로직

> 핵심: **충전 요/불필요는 태스크 성공·실패가 직접 정하지 않는다.**
> 별도의 **배터리 임계 모니터(2초 주기)**가 독립적으로 판단한다. 태스크 완료는 로봇을 IDLE로 만들어
> "충전 디스패치를 받을 수 있는 상태"로만 풀어준다. (자동으로 충전소로 보내는 로직은 없음 — 알림/수동·자동충전 트리거)

상수 (`robot-monitor.service.ts`):
- `LOW_BATTERY_PCT = 20` (env `LOW_BATTERY_PCT`)
- `CHARGE_TARGET_PCT = 80` (env `CHARGE_TARGET_PCT`)

### 충전 "요" (필요) — `checkLowBattery`
- 조건: 온라인 + 비충전 + **배터리 ≤ 20%**
- 동작: `Alert.lowBattery` 관제 알림(프론트: **확인 / 자동충전** 버튼) — **에피소드당 1회**
- 재무장: 배터리 **+5%(=25%) 회복** 또는 충전 시작 시 해제 → 다음 저하 때 다시 알림
  (회복 시 `Alert.charged` "배터리 충전됨" 1회)

### 충전 "불필요/완료" — `reconcileChargingStatus`
- 조건: 상태 CHARGING + **배터리 ≥ 80%** → **IDLE** (충전 종료)
- 또는 battery_state가 명시적 방전(power_supply_status=2)으로 바뀌면 CHARGING→IDLE
- 진행 태스크 없을 때만 동작(`!hasActive`)

### 충전 추천 우선순위 — `robot-priority.ts` (CHARGE 분기)
- `1) 온라인 → 2) 비busy → 3) 배터리 적은 순(낮을수록 먼저)`
- 즉 **가장 충전이 급한(배터리 낮은) 로봇 우선** 추천
- (다른 태스크는 `온라인 → 비busy → 배터리 40%↑ → 거리` 순)

---

## 6. 한 줄 요약
- **MOVE·PROCESS·SUPPLY·RECALL·PAUSE + 단건/연속/시나리오/ERROR**: ROS 정상 연결 ✅
- **CHARGE**: 충전소 노드 해석 단계 누락 → 현재 FAILED ⚠️ (RECALL 패턴으로 한 단계 추가하면 해결)
- **로봇 상태**: `RobotService.updateStatus` 단일 작성, dispatch(주행)·robot-monitor(감시/충전/전복)·task-manager(취소/정지)가 호출
- **충전 요/불필요**: 태스크 결과와 무관한 **배터리 임계(20%/80%) 2초 모니터**가 결정
