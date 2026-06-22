# FMS 인수인계 가이드 (여기부터 읽으세요)

> 이 문서는 이 프로젝트의 **FMS(Fleet Management System) 백엔드(`web_back`)를 처음 보는
> 사람**을 위한 온보딩/인수인계 가이드입니다. "이게 무슨 시스템이고, 어떻게 돌아가고,
> 어디를 고치면 되는지"를 순서대로 설명합니다.
> 파일 하나하나의 위치가 궁금하면 같은 폴더의 [`FMS_LOGIC_MAP.md`](./FMS_LOGIC_MAP.md)를 보세요.

---

## 0. 30초 요약

여러 대의 자율주행 로봇(터틀봇 등)을 **노드–엣지 그래프(맵 위의 정류장과 길) 위에서**
관리한다. 관제/AI가 "이 로봇을 저 노드로 보내" 같은 **태스크**를 만들면, 백엔드가
**큐에 쌓고 → 로봇에 배정 → 최단경로 계산 → 노드를 하나씩 밟아 이동 → 완료**까지
자동으로 처리한다. 로봇과는 **ROS(rosbridge 웹소켓)**로, 프론트와는 **Socket.IO**로,
영속 데이터는 **MongoDB**로 주고받는다.

핵심 진입점은 단 하나: **`TaskManagerService`** (파사드). 실제 일은 역할별로 잘게 나뉜
주입형 서비스들이 한다.

---

## 1. 큰 그림 (구성요소)

```
   [브라우저 관제 UI]                         [EXAONE/LLM AI]
        │  Socket.IO  (실시간 상태/알림)            │ REST /ai , ai_ask
        ▼                                          ▼
 ┌──────────────────────── NestJS 백엔드 (web_back, :3001) ─────────────────────────┐
 │  Gateway(Socket.IO)   REST 컨트롤러(api/...)                                       │
 │        │                     │                                                    │
 │        ▼                     ▼                                                    │
 │   ┌─────────────── FMS (TaskManagerService = 파사드) ───────────────┐            │
 │   │ 글로벌큐 · 로봇별큐 · 배차 · 경로탐색 · 주행실행 · 노드잠금 · 감시 │            │
 │   └───────────────────────────────────────────────────────────────┘            │
 │        │ ROS 발행/구독 (RosService)         │ Mongoose                            │
 └────────┼──────────────────────────────────┼─────────────────────────────────────┘
          │ rosbridge ws://localhost:9090     │
          ▼                                    ▼
   [실제 로봇들 (ROS2/Nav2/AMCL)]        [MongoDB: ros_dashboard]
   [또는 백엔드 내장 가상 테스트봇]        fleet_robots/nodes/edges/maps, fms_tasks, logs
```

- **로봇 ↔ 백엔드**: `rosbridge`를 통해 토픽을 주고받는다. 백엔드는 `/<botId>/amcl_pose`,
  `/<botId>/battery_state`, `/<botId>/imu`를 **구독**하고, `/<botId>/goal_pose`,
  `/<botId>/cmd_vel`, `/<botId>/initialpose`를 **발행**한다.
- **하드웨어가 없어도** 백엔드 내장 **가상 테스트봇**(`TEST-BOT1`~`TEST-BOT4`)이 rosbridge
  없이 같은 코드 경로로 동작한다 → 개발/테스트는 이걸로 한다. (8장 참고)

---

## 2. 5분 만에 돌려보기

### 필요한 것
- Node 20.6+ (`.env`는 `process.loadEnvFile()`로 자동 로드, 없으면 코드 기본값)
- MongoDB 실행 중 (`mongod`) — 기본 `mongodb://127.0.0.1:27017/ros_dashboard`
- (선택) 실제 로봇/시뮬레이터 + `rosbridge_server` (없어도 가상봇으로 동작)

### 실행
```bash
cd web_back
npm install
npm run start          # 또는 start:dev (watch)
# → http://localhost:3001
```
서버가 뜨면 가상 테스트봇 4대가 자동으로 온라인이 된다(rosbridge 불필요). 로그에
`가상 테스트봇 TEST-BOT1, ... 시작`이 보이면 정상.

### 첫 태스크 보내보기
태스크를 보내려면 먼저 **맵의 노드/엣지(토폴로지)**가 DB에 있어야 한다(없으면 경로가
안 나온다). 토폴로지는 보통 프론트 맵 에디터나 `api/fleet/topology` REST로 만든다.
노드가 있다면:
```bash
curl -X POST http://localhost:3001/api/fms/tasks \
  -H 'Content-Type: application/json' \
  -d '{"type":"MOVE","targetNode":"<도착노드ID>","preferredRobotId":"TEST-BOT1"}'
```
다음 tick(1초)에 배차되어 `TEST-BOT1`이 그 노드로 이동하고 완료된다.
진행은 `GET http://localhost:3001/api/fms/tasks`로 확인.

> 토폴로지가 전혀 없는 깨끗한 환경에서 전 과정을 한 번에 보고 싶으면 **8장의 e2e 테스트**를
> 실행하면 된다(토폴로지 시드 → 배차 → 완료까지 자동).

---

## 3. 꼭 알아야 할 개념 (용어집)

| 용어 | 뜻 |
|---|---|
| **노드(Node)** | 맵 위의 한 지점(정류장/경유점/충전소). `node_id`, 좌표 `x,y,yaw`, `type`, `isLocked` |
| **엣지(Edge)** | 두 노드를 잇는 길. `weight`(비용), `isLocked`. 경로탐색은 모든 엣지를 양방향으로 본다 |
| **토폴로지(Topology)** | 노드+엣지로 이뤄진 그래프. `TopologyService`가 CRUD/잠금 담당 |
| **맵(map) vs fleet-map** | `map` = 실시간 SLAM/점유격자 이미지(PNG)+로봇↔맵 할당. `fleet-map` = 논리 맵 정의(map_id·로봇 초기위치). 둘 다 `src/map/`에 있음 |
| **태스크(Task)** | 로봇에게 시키는 일 1건. `type`+`targetNode`(+우선순위/지정로봇) |
| **글로벌 큐** | 아직 어느 로봇에도 안 붙은 `PENDING` 태스크들 (Mongo) |
| **로봇별 큐** | 특정 로봇에 커밋된 태스크 (활성 1개 + 대기 FIFO, 인메모리) |
| **점유(occupancy)** | 어떤 노드를 지금 어느 로봇이 밟고 있는지(인메모리). 경로탐색에서 회피 대상 |
| **노드 잠금(node lock)** | 노드를 폐쇄(장애/관제) → 경로탐색에서 제외 + 경유 중 로봇 자동 우회 |
| **AMCL** | 로봇의 자기위치추정. `amcl_pose` 토픽으로 위치가 들어온다 |
| **웨이포인트 도달** | `amcl_pose` 위치가 다음 노드 임계반경 안에 들어오면 "도착"으로 판정 |
| **경로탐색** | 출발→도착 최단경로(Dijkstra). `PathfindingService` |

---

## 4. 데이터 모델 (MongoDB)

**Task** (`fms_tasks`)
| 필드 | 설명 |
|---|---|
| `task_id` | 사람이 읽는 ID (`TASK-...`) |
| `type` | `SUPPLY` / `PROCESS` / `CHARGE` / `MOVE` |
| `status` | `DRAFT`→`PENDING`→`ASSIGNED`→`RUNNING`→(`SUSPENDED`)→`COMPLETED`/`FAILED` |
| `targetNode` | 도착 노드 ID (SUPPLY는 보급 품목 의미) |
| `priority` | 1(긴급)~10(낮음), 기본 5. 배차는 `priority ASC, createdAt ASC` 순 |
| `preferredRobotId` | 지정 로봇(없으면 임의 배정). 문자열 `"null"`은 null로 취급 |
| `assignedRobotId` | 실제 배정된 로봇 |
| `pathQueue` | 남은 경유 노드(진행하며 줄어듦) |
| `fullPath` | 배정 시점 확정 전체 경로(시각화용) |
| `waitReason` | 대기/실패 사유 |
| `startedAt` / `completedAt` | 시작/종료 시각 |

**Node** (`fleet_nodes`): `node_id`, `map_id`, `type`(`WAYPOINT`/`STATION`/`CHARGER`), `x`,`y`,`yaw`, `isLocked`
**Edge** (`fleet_edges`): `edge_id`, `map_id`, `startNode`, `endNode`, `direction`, `weight`(기본1), `isLocked`
**Robot** (`fleet_robots`): `robot_id`, `status`(`IDLE`/`MOVING`/`WORKING`/`ERROR`/`OFFLINE`), `location`(현재 node_id), `pose_x/y`, `yaw`, `battery`, `lastSeenAt`
**FleetMap** (`fleet_maps`): `map_id`, `init_position`(로봇별 초기 위치)

---

## 5. ⭐ 태스크 한 개의 일생 (가장 중요)

이걸 이해하면 80%는 끝. `MOVE` 태스크 기준 해피패스:

```
1) 생성    enqueue(dto)
   → GlobalTaskQueueService → Mongo에 status=PENDING 저장, fms_task_created 브로드캐스트

2) 배차    DispatchService.process()  (매 tick=1초)
   ├ 온라인 IDLE 로봇 수집 (lastSeen 신선 + status IDLE)
   ├ preferredRobotId 가용? → 그 로봇에 배정 / 작업중이면 '로봇별 큐'에 적재 (10장)
   └ NavigationTaskHandler.handle()
        ├ 출발 노드 결정: robot.location → (없으면) AMCL 최근접 노드
        ├ PathfindingService.findPath(출발, 도착)  ← 경로탐색이 '실행되는' 지점
        ├ robotTasks.setActive · DB ASSIGNED · robot MOVING · 도착 노드 잠금
        └ NavGoalService.sendNodeActionGoal(첫 노드)  → /<bot>/goal_pose 발행

3) 주행    (로봇이 이동하며 /<bot>/amcl_pose 발행)
   → RobotTelemetryService 가 수신 → NavigationService.onAmclPose()
   → NavigationService.checkWaypointArrival()
        ├ 다음 노드 임계반경 안? 아니면 return
        ├ 중간 노드 도달: pathQueue.shift → 다음 노드 goal
        │     (방향이 45° 넘게 꺾이면 2초 정지 후 제자리 회전 → 수렴하면 진행)
        └ 최종 노드 도달: DB COMPLETED · robot IDLE · 노드 잠금 해제 · 점유 해제
              → DispatchService.dispatchNext(robot)  (로봇별 큐 다음 태스크, 없으면 홈복귀)

4) 충돌회피 NavigationService.checkNodeConflicts() (매 tick)
   → 2칸 앞 노드를 다른 로봇이 점유 중이면 정지, 비워지면 재출발
```

`SUPPLY` 태스크는 omx 로봇팔 전용이라 **이동 단계를 건너뛰고** `SupplyTaskHandler`가
즉시 완료 처리한다. (실제 로봇팔 액션 연동 지점)

---

## 6. tick 루프 (`TaskManagerService.tick`, 1초)

```
monitor.syncOnlineStatus()      # lastSeen 기반 온라인↔오프라인 전환 + 정리
navRecovery.checkAmclTimeout()  # amcl_pose 60초 끊김 → 태스크 SUSPENDED
dispatch.process()              # 글로벌 큐 → 로봇 배정
navigation.checkNodeConflicts() # 2-ahead 노드 충돌 정지/재출발
```
이벤트(로봇 위치/배터리/IMU)는 tick과 별개로 ROS 수신 즉시 `RobotTelemetryService`가 처리.

---

## 7. 경로탐색 · 로봇별 큐 · 노드 잠금 (핵심 3종)

**경로탐색** (`PathfindingService.findPath`, `src/pathfinding/`)
- 표준 **다익스트라**. 비용 = 엣지 `weight`.
- 제외 대상: 잠긴 노드/엣지, 다른 로봇이 점유 중인 노드, `weight≤0` 엣지, (출발지가 아닌) 충전소 경유.
- 출발/도착 노드 자신은 잠겨/점유돼 있어도 예외로 허용.

**로봇별 큐** (`RobotTaskQueueService`, `src/fms-state/`)
- `active`: 로봇당 실행 중 1개 / `queued`: 대기 FIFO.
- preferred 로봇이 작업 중이면 새 태스크를 그 로봇 큐에 적재(상태 `ASSIGNED` + `대기열 N번`).
- 로봇이 일을 끝내면 `dispatchNext()`가 큐의 다음을 꺼내 실행. 큐 비면 홈 복귀.
- 로봇이 **오프라인**되면 그 로봇의 대기 태스크는 글로벌 큐로 **반환(재배차)**.

**노드 잠금/우회** (`NodeLockService.lockNode`, `src/fms/node-lock/`)
1. DB 잠금 + `node_lock_changed` 브로드캐스트(`TopologyService`)
2. 그 노드를 경유 중인 **모든 활성 로봇**의 경로를 재계산해 우회시킨다. 우회 불가면 정지+대기.

---

## 8. 하드웨어 없이 테스트하기 (가상 테스트봇)

`src/ros/virtual-robot/virtual-robot.service.ts` — 백엔드 안에서 도는 가상 로봇 4대
(`TEST-BOT1`~`TEST-BOT4`). rosbridge 없이 `amcl_pose/odom/battery`를 주입하고,
`goal_pose`를 가로채 **직선으로 이동하며 항상 도착에 성공**한다. 즉 실제 로봇과 똑같은
코드 경로를 타므로 FMS 로직 전체를 그대로 검증할 수 있다.

**자동 검증(e2e)** — 로컬 MongoDB 필요(별도 `fms_verify` DB 사용, 운영 데이터 안 건드림):
```bash
npm run test:e2e -- fms-pipeline
```
검증 내용: 가상봇 온라인 → 토폴로지 시드 → **경로탐색·배차·주행·완료** → **로봇별 큐잉
순차 실행**. 코드: `test/fms-pipeline.e2e-spec.ts` (새 시나리오 추가 시 여기에).

**그 밖의 점검**
```bash
npx nest build      # 타입/빌드
npx jest            # 단위 테스트
```

---

## 9. 장애·복구 시나리오 (어디서 처리되나)

| 상황 | 처리 | 담당 |
|---|---|---|
| 위치(AMCL) 60초 끊김 | 태스크 `SUSPENDED` 보류 → 복구되면 자동 재개 | `NavRecoveryService` |
| 로봇 6초 무수신 | `OFFLINE` 전환, 활성태스크 `FAILED`, 대기태스크 글로벌큐 반환 | `RobotMonitorService` |
| 전복(IMU roll/pitch>45°) | `ERROR` + 전복지점 노드 장애 잠금(다른 로봇 우회), 복귀 시 자동 해제 | `FallDetectionService` |
| 맵 변경 | 활성 태스크 취소, 위치/캐시 초기화, 주행 중단 | `TaskManagerService.handleMapChange` |
| 취소/긴급정지 | 현재 위치로 goal 덮어쓰기 + cmd_vel 0, 태스크 `FAILED`, 큐 다음 진행 | `TaskManagerService.cancelTask/stopRobot` |
| 서버 재시작 | 메모리 잃은 진행 태스크 `FAILED` 복구 | `RobotMonitorService.recoverActiveTasks` |

---

## 10. 코드 지도 (요약)

상세 파일별 지도는 [`FMS_LOGIC_MAP.md`](./FMS_LOGIC_MAP.md). 큰 원칙만:

- **결합 0(순수)** 인 것은 `src/` 최상위로: `pathfinding/`, `fms-state/`(상태 스토어),
  `fms-shared/`(타입·유틸·상수), `fms-events/`(알림 발행).
- **결합 있는** FMS 로직은 `src/fms/` 폴더 안에: `dispatch/`(+`task-handlers/`),
  `navigation/`, `node-lock/`, `monitor/`, `queue/global-task-queue`.
- 플릿 인프라는 도메인별 최상위 폴더: `robot/`, `topology/`, `telemetry/`,
  `collision-avoidance/`, `node-occupancy/`, `map/`.
- `TaskManagerService`(파사드) = 외부 공개 API + tick 루프만 담당.

---

## 11. 외부 인터페이스

### REST (베이스 `http://localhost:3001`)
| 경로 | 용도 |
|---|---|
| `api/fms/tasks` | 태스크 목록/생성(POST)/단건/취소(DELETE …/cancel)/삭제 |
| `api/fms/ai-chat` | 자연어 → 태스크 파싱 후 자동 실행 |
| `api/fleet/topology` | 노드/엣지 CRUD, `path`(경로조회), 노드 잠금/이름변경 |
| `api/fleet/robots` | 로봇 CRUD |
| `api/fleet/maps` | 논리 맵 정의·로봇 초기위치 |
| `api/map` | 실시간 SLAM 맵(PNG) |
| `api/logs`, `api/vision`, `ai` | 로그 / 비전 / AI |

### Socket.IO — 프론트→백엔드(inbound)
`fms_dispatch_task`(배차), `fms_register_task`(DRAFT 등록), `fms_release_task`(DRAFT→배차),
`fms_cancel_task`, `fms_get_tasks`, `node_lock`, `task_manager_set_home`, `task_manager_ack`,
`nav_set_initialpose`, 그 밖에 `publish/cmd_vel/send_action`, `nl_command`, `ai_ask`, WebRTC.

### Socket.IO — 백엔드→프론트(outbound)
`fms_task_created`, `fms_task_updated`, `task_manager_alert`(관제 알림),
`robot_status_changed`, `robot_registered`, `node_lock_changed`, `node_occupancy_changed`,
`robot_telemetry`, `robots_init`, `map_updated/map_cleared`.

### 파사드 공개 메서드 (`TaskManagerService`)
`enqueue`, `register`, `releaseTask`, `cancelTask`, `stopRobot`, `returnHomeNow`,
`lockNode`, `getLockedNodeIds`, `setHomePosition`, `setInitialPoseAndLocation`,
`handleMapChange`, `setServer`, `ackAlert`.

---

## 12. 자주 하는 작업 (How-to)

**새 태스크 타입 추가**
1. `src/fms/task.schema.ts`의 `TaskType`에 추가.
2. `TaskHandler` 인터페이스 구현체를 `src/fms/dispatch/task-handlers/`에 추가.
3. `fms.module.ts` providers에 등록.
4. `DispatchService.runHandler()`에서 타입 분기 추가.

**새 로봇 추가** — 그 로봇이 ROS 토픽(`/<id>/amcl_pose` 등)만 보내기 시작하면
`autoRegister`로 자동 등록·온라인된다. 가상봇을 늘리려면 `virtual-robot.service.ts`의
`TEST_BOT_IDS` 수정.

**노드 잠그기/홈 등록** — 프론트에서 `node_lock` / `task_manager_set_home` 소켓 이벤트,
또는 파사드 `lockNode/setHomePosition` 호출.

---

## 13. 함정·비직관적인 것 (gotchas)

- **서버(socket)가 안 붙으면 배차가 멈춘다.** `TaskManagerService.setServer()`가 호출되기
  전엔 `dispatch.process()`가 그냥 return 한다(게이트웨이 `afterInit`에서 주입됨). 테스트에서
  단독 구동할 땐 no-op 서버를 주입해야 한다.
- **경로탐색은 엣지를 항상 양방향**으로 본다(`direction` 필드는 탐색에서 무시).
- **도착 임계값이 적응형**이다. 노드 간격이 좁은 맵(예: 401)에서 노드를 건너뛰지 않도록
  직전→다음 노드 거리의 일부를 임계로 쓴다. `TEST`로 시작하는 가상봇은 더 작은 임계(×0.01).
- **로봇별 큐는 인메모리**라 서버 재시작 시 사라진다(진행/대기 태스크는 복구 시 `FAILED`).
- **`fms-state`/`fms-shared`/`fms-events`는 `src/` 최상위에 있지만 `FmsModule`의 provider**다
  (파일 위치 ≠ 모듈 소속). `pathfinding`이 `FleetModule` provider인 것과 같은 패턴.
- 토폴로지(노드/엣지)가 DB에 없으면 어떤 태스크도 경로를 못 찾는다(직행 처리되거나 실패).

---

## 14. 디버깅 팁

로그는 `[태그]`로 검색하면 빠르다:
`[dispatch]`(배차·경로확정), `[goal_pose]`(목표 전송), `[웨이포인트]`(도달 판정),
`[코너]`(회전), `[로봇큐]`(로봇별 큐), `[노드 폐쇄]`/`[재경로]`(우회), `[AMCL타임아웃]`/`[AMCL복구]`,
`[전복-장애]`/`[전복복구]`, `[오프라인 보정]`, `[TM]`(관제 알림).

---

## 15. 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/ros_dashboard` | MongoDB |
| `ROSBRIDGE_URL` | `ws://localhost:9090` | rosbridge |
| `MAPS_DIR` | `/home/js/map` | SLAM 맵/할당 파일 위치 |
| `OLLAMA_URL` / `OLLAMA_NL_MODEL` | `http://127.0.0.1:11434` / `exaone3.5:latest` | AI |

서버 포트는 `3001` 고정(`main.ts`), CORS·본문한도(15mb) 설정 포함.
