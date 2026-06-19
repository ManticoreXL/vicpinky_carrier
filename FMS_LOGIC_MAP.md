# FMS 로직 가이드 — Task Manager & Traffic Manager

> "어디에서 무엇을 수정하면 어떤 동작이 바뀌는가"를 정리한 지도입니다.
> 모든 `file:line`은 2026-06-19 리팩터링 직후 기준. (리팩터링 내역은 맨 아래 §6)

---

## 1. 전체 데이터 흐름

```
[프론트]                         [소켓 게이트웨이]              [서비스 계층]
TaskManagerView / FmsView  ──►  ros.gateway.ts          ──►  TaskManagerService  (디스패치·경로추종·감시)
  emitFmsDispatch()              @SubscribeMessage(...)         │   ├─ FmsService            (DB CRUD + ROS 발행)
  emitFmsCancel()                                               │   ├─ TopologyService       (A* 경로탐색·노드잠금)
  AI 챗 (fetch /ai/agent)                                       │   ├─ CollisionAvoidance    (충돌 회피 = Traffic Manager)
                                                                │   ├─ RobotService          (로봇 상태/위치 DB)
[로봇] ──ROS(amcl/imu/battery/odom)──► RosService ──onMessage──►┘   └─ TelemetryService

서버 → 프론트 브로드캐스트: fms_task_created / fms_task_updated / task_manager_alert /
                            robot_status_changed / node_lock_changed
```

핵심 한 줄 요약:
- **Task Manager** = `web_back/src/fms/task-manager.service.ts` — 태스크를 로봇에 배정하고, ROS 위치를 받아 노드 단위로 주행시키며, 전복/오프라인/AMCL 끊김을 감시.
- **Traffic Manager** = `web_back/src/fleet/collision-avoidance.service.ts` — "2칸 앞 노드 예약" 방식 충돌 회피. 정지/재출발 **결정만** 내리고, 실제 정지·재출발은 Task Manager가 실행.

---

## 2. 파일별 책임 요약

### 백엔드 (`web_back/src/`)

| 파일 | 역할 | 핵심 진입점 |
|---|---|---|
| `fms/task-manager.service.ts` | **Task Manager 본체.** 매 1초 루프, 디스패치, 경로 추종, 코너 회전, 감시 | `tick()` `process()` |
| `fleet/collision-avoidance.service.ts` | **Traffic Manager.** 충돌 정지/재출발 의사결정(순수) | `evaluate()` |
| `fms/fms.service.ts` | 태스크 DB CRUD + ROS 발행(goal/stop/initialpose) | `publishGoal/Stop/InitialPose` |
| `fms/fms.controller.ts` | REST API (`/api/fms/...`) + AI 챗 | `@Post('ai-chat')` |
| `fms/fms.module.ts` | DI 묶음 (FmsService + TaskManagerService) | — |
| `fms/task.schema.ts` | Task 몽고 스키마 + 상태/타입 enum | `TaskStatus` `TaskType` |
| `fleet/topology.service.ts` | A* 경로탐색, 노드 잠금, 최근접 노드 | `findPath()` |
| `gateway/ros.gateway.ts` | 소켓 ↔ 서비스 연결 (`@SubscribeMessage`) | line 294~ |
| `ai/agent.service.ts` | LLM 툴콜 → Task Manager 호출 | `dispatch_task` 등 |

### 프론트 (`web_front/src/`)

| 파일 | 역할 |
|---|---|
| `views/TaskManagerView.tsx` | Task Manager UI 3컬럼 (AI챗 / 로봇모니터 / 작업현황) |
| `views/FmsView.tsx` | FMS 맵 + 태스크 발행 폼 |
| `hooks/useNestSocket.ts` | 소켓 연결, 이벤트 수신/발신(`emitFmsDispatch` 등) |
| `utils/statusLabel.ts` | 상태/타입 한글 라벨 매핑 |

---

## 3. 동작별 "수정 위치" 매핑 (★ 가장 중요)

### 3-A. 튜닝 상수 — 숫자만 바꾸면 동작이 바뀌는 것들

| 바꾸고 싶은 동작 | 위치 | 현재값 |
|---|---|---|
| 감시 루프 주기 | `task-manager.service.ts:15` `LOOP_MS` | 1000ms |
| "온라인" 판정 임계 (디스패치 가용) | `task-manager.service.ts:16` `ONLINE_MS` | 5000ms |
| 오프라인 전환 속도 | `task-manager.service.ts:19` `OFFLINE_AFTER_MS` | 6000ms |
| AMCL 끊김 → 태스크 일시정지까지 | `task-manager.service.ts:20` `AMCL_TIMEOUT_MS` | 60000ms |
| 전복(전도) 판정 각도 | `task-manager.service.ts:22` `FALL_THRESH_RAD` | 45° |
| **중간 노드 통과 감지 반경** | `task-manager.service.ts:25` `NODE_PASS_M` | 1.5m |
| **최종 도착 감지 반경** | `task-manager.service.ts:26` `NODE_ARRIVE_M` | 0.5m |
| 코너 정지 대기 시간 | `task-manager.service.ts:110` `CORNER_WAIT_MS` | 2000ms |
| 코너로 판정하는 회전각 | `task-manager.service.ts:111` `CORNER_THRESH` | 45° |
| 코너 회전 완료(yaw 수렴) 허용오차 | `task-manager.service.ts:112` `YAW_CONVERGE_THRESH` | 0.15rad |
| 코너 회전 강제진행 타임아웃 | `task-manager.service.ts:113` `CORNER_SAFETY_MS` | 8000ms |
| **충돌 회피 점유 반경** | `collision-avoidance.service.ts:7` `NODE_PASS_M` | 1.5m |
| 진입 불가(비메인 도로) 가중치 | `topology.service.ts:11` `MIN_WEIGHT` | 0.1 |

### 3-B. 알고리즘 — 로직 자체를 바꿀 때

| 바꾸고 싶은 로직 | 위치 |
|---|---|
| **로봇↔태스크 배정 규칙** (우선순위/지정로봇/임의배정) | `task-manager.service.ts:942` `process()` 의 dispatch 루프 (966~) |
| **출발노드·경로 결정** (location vs AMCL, 재탐색) | `task-manager.service.ts:855` `resolveDispatchPath()` |
| **다익스트라 경로탐색** (비용함수·CHARGER 경유·잠금 반영) | `topology.service.ts:107` `findPath()` (비용 `1/weight` = line 159~, CHARGER 정책 145·154~) |
| **노드 도착 판정 + 다음 goal 전송** | `task-manager.service.ts:630` `checkWaypointArrival()` |
| **코너 회전** (정지→회전→yaw수렴 대기) | `task-manager.service.ts:704~726` (감지) + `:406` (수렴판정, `handleRosMessage` 내) |
| **충돌 회피 판정(1칸 앞 예약)** | `collision-avoidance.service.ts:65` `evaluate()` (점유 탐색 104~) |
| 충돌 결정의 **실제 정지/재출발 실행** | `task-manager.service.ts:590` `checkNodeConflicts()` |
| **전복 감지 → ERROR + 노드 잠금** | `task-manager.service.ts:372` `handleRosMessage()` 의 IMU 블록 (전복 쿨다운 30s) |
| **오프라인 감지 → 태스크 FAILED** | `task-manager.service.ts:752` `syncOnlineStatus()` |
| **AMCL 끊김 → SUSPENDED → 자동재개** | `:495` `checkAmclTimeout()` / `:535` `checkAmclResume()` |
| **노드 폐쇄 시 실시간 우회 재경로** | `task-manager.service.ts:315` `lockNode()` |
| **태스크 취소 시 로봇 정지** | `task-manager.service.ts:212` `cancelTask()` |
| **맵 전환 시 초기화** | `task-manager.service.ts:257` `handleMapChange()` |
| **홈 복귀** | `:199` `returnHomeNow()` + `returnHome()` (private) |

### 3-C. ROS 발행 (실제 로봇에 나가는 명령)

| 바꾸고 싶은 것 | 위치 |
|---|---|
| goal_pose 메시지 포맷 | `fms.service.ts:145` `publishGoal()` |
| 정지(cmd_vel=0) 포맷·토픽 (tb3/omx=TwistStamped, vicpinky=Twist) | `fms.service.ts:162` `publishStop()` + `:37` `cmdVelTarget()` |
| initialpose 메시지(공분산 등) | `fms.service.ts:175` `publishInitialPose()` |
| 정지를 몇 번 반복 발행할지 | `task-manager.service.ts` `hardStop()` (현재 3회) |

### 3-D. 소켓/REST 진입점 (프론트 → 백엔드)

| 프론트 동작 | 프론트 송신 | 백엔드 핸들러 | 호출 |
|---|---|---|---|
| 태스크 발행 | `emitFmsDispatch` → `fms_dispatch_task` | `ros.gateway.ts:294` | `taskManager.enqueue()` |
| 태스크 취소 | `emitFmsCancel` → `fms_cancel_task` | `ros.gateway.ts:324` | `taskManager.cancelTask()` |
| 노드 잠금 | `node_lock` | `ros.gateway.ts:317` | `taskManager.lockNode()` |
| 초기위치 설정 | `nav_set_initialpose` | `ros.gateway.ts:346` | `taskManager.setInitialPoseAndLocation()` |
| 홈 설정 | `task_manager_set_home` | `ros.gateway.ts:308` | `taskManager.setHomePosition()` |
| AI 명령 | `fetch POST /ai/agent` | `ai/agent.service.ts` 툴콜 | `dispatch_task`/`stop_robot` 등 → TaskManager |
| REST 태스크 CRUD | `/api/fms/tasks` | `fms.controller.ts:17~50` | FmsService / TaskManager |

### 3-E. 프론트 UI 동작

| 바꾸고 싶은 것 | 위치 |
|---|---|
| 화면에 뜨는 로봇 목록 | `TaskManagerView.tsx:9` `ROBOTS` 배열 |
| 충전 버튼 → 최근접 충전소 선택 | `TaskManagerView.tsx:187` `handleCharge()` |
| 로봇 상태 색/도트/라벨 | `TaskManagerView.tsx` `robotVisual()` (리팩터링으로 1개로 통합) |
| 태스크 타입 색상 | `TaskManagerView.tsx:18` `TASK_COLORS` |
| 상태 한글 라벨 | `utils/statusLabel.ts` |
| 소켓 이벤트 수신 처리 | `hooks/useNestSocket.ts:217~286` |

---

## 4. 자주 묻는 시나리오별 "여기를 고치세요"

- **"로봇이 노드를 너무 멀리서 통과 처리한다"** → `NODE_PASS_M` (`task-manager.service.ts:25`).
- **"도착했는데 완료가 안 된다 / 너무 일찍 완료된다"** → `NODE_ARRIVE_M` (`:26`) + `checkWaypointArrival()` 최종 분기(`:666` 부근).
- **"두 로봇이 너무 가까이서/멀리서 멈춘다"** → `collision-avoidance.service.ts:7` `NODE_PASS_M`.
- **"코너에서 안 돌고 직진한다 / 너무 자주 멈춘다"** → `CORNER_THRESH`(`:111`), 회전 로직 `:704~`.
- **"오프라인 판정이 너무 빠르다/느리다"** → `OFFLINE_AFTER_MS`(`:19`), 로직 `syncOnlineStatus()`(`:752`).
- **"특정 로봇만 쓰게 하고 싶다"** → 디스패치의 `preferredRobotId` 처리 `process()` `:973~`.
- **"경로가 충전소를 가로질러 간다"** → `findPath()` CHARGER 정책 `topology.service.ts:154~`.

---

## 5. 미사용 코드 (제거 후보 — 동작에 영향 없음)

호출처가 없어 안전하게 지울 수 있으나, public 메서드라 "기능 미변경" 원칙상 **이번엔 남겨둠**. 정리 원하면 삭제 가능:

- `fms.service.ts:130` `setRunning()` — 호출처 없음
- `fms.service.ts:215` `cancel()` — `TaskManagerService.cancelTask()`로 대체됨
- `fms.service.ts:240` `activeCount()` — 호출처 없음
- `topology.service.ts:208` `findNearestStation()` — 호출처 없음

---

## 6. 이번 리팩터링 변경 요약 (동작 100% 보존, 타입체크 통과)

기계적으로 동등한 추출/중복제거만 수행. 제어 흐름·실행 순서·단락평가 변경 없음.

**`task-manager.service.ts`**
- 순수 헬퍼 추가: `normalizeAngle()`, `quatToYaw()`, `emptyCache()` (모듈 함수) + `hardStop()` (private)
- 중복 제거: 빈 캐시 리터럴 4곳 → `emptyCache()`, 각도 정규화 `while` 2곳 → `normalizeAngle()`, 정지 3회 발행 3곳 → `hardStop()`, 쿼터니언→yaw 인라인 → `quatToYaw()`
- 거대 `process()`(약 170줄) 분리:
  - `reconcileActiveTasks()` — 완료/실패 태스크 정리
  - `recoverStuckMoving()` — MOVING 고착 복구
  - `resolveDispatchPath()` — 출발노드·경로 해석(약 78줄)
  - → `process()`는 이제 "정리 → PENDING 조회 → 가용로봇 → 배정 루프" 오케스트레이션만 담당

**`TaskManagerView.tsx`**
- `statusDot` / `statusLabel` / `statusColor` 3개의 병렬 switch → `robotVisual()` 하나로 통합 (색 매핑 동일)

**변경 안 함 (이미 잘 정리됨):** `collision-avoidance.service.ts`, `fms.service.ts`, `topology.service.ts`, `fms.controller.ts`, 프론트 나머지.
