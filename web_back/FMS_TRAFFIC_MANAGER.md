# FMS Traffic Manager — 충돌 회피 / 교차점 양보 (현재 코드 기준)

> ROS2 이기종 로봇 플릿이 **같은 토폴로지 노드를 동시에 점유하지 않도록** 조정하는 교통 관리 서브시스템.
> 태스크 매니저(`FMS_TASK_MANAGER.md`)의 2초 tick이 호출하는 **백엔드 주도(backend-driven)** 로직이다. ROS 계층엔 별도 교통 제어가 없다(로봇은 goal만 받고 위치만 보고).
>
> 이력: 과거 1초 tick의 "충돌 양보"는 제거됐다가, **1-ahead 우선순위→FIFO 양보**로 재설계되어 복원됨(`task-manager.service.ts` 주석 "복원").

---

## 0. 핵심 모델 — 3계층

| 계층 | 시점 | 책임 | 서비스 |
|---|---|---|---|
| **정적 회피** | 경로 계획(dispatch) | 잠긴 노드 + 점유 노드를 **빼고** 경로 계산 | `PathfindingService` ← `NodeOccupancyService.getOccupiedNodeIds` / `NodeLockService` |
| **동적 양보** | 런타임(2초 tick) | 같은 노드를 노리는 두 로봇 중 **낮은 우선순위만 정지**, 우선권 확보 시 재출발 | `CollisionAvoidanceService` |
| **점유 추적** | 노드 도착마다 | 누가 어느 노드를 점유 중인지 인메모리로 관리 + 프론트 시각화 | `NodeOccupancyService` |

> 설계 철학: **경로는 dispatch 때 한 번** (당시 점유/잠금 스냅샷 반영) 계산하고, **실시간 충돌은 런타임에 양보로 해결**한다. 사전 예약(reservation)·스케줄링은 없다.

---

## 1. 파일 지도

```
src/
├─ collision-avoidance/
│  └─ collision-avoidance.service.ts  # ★ 1-ahead 우선순위 양보 (순수 의사결정: stop/resume)
├─ node-occupancy/
│  └─ node-occupancy.service.ts       # ★ robotToNode/nodeToRobot 양방향 점유 맵 + 소켓 발행
├─ fms/
│  ├─ node-lock.service.ts            # 수동 노드 잠금 (운영자 폐쇄 — TopologyService 래퍼)
│  ├─ task-priority.ts                # trafficPriority(=-TYPE_PRIORITY) — 양보 우선권 단일 출처
│  ├─ task-execution.service.ts       # checkNodeConflicts() — 상태수집→evaluate→정지/재출발 적용 + 도착 시 점유
│  └─ task-manager.service.ts         # 2초 tick이 checkNodeConflicts 호출
└─ pathfinding/
   └─ pathfinding.service.ts          # findPath(Dijkstra) — 점유/잠금 노드 제외
```

---

## 2. CollisionAvoidanceService — 1-ahead 우선순위 양보

`collision-avoidance/collision-avoidance.service.ts`. **순수 의사결정 서비스** — 정지/재출발 "결정"과 그 상태만 책임지고, 실제 cmd_vel 발행·goal 재전송은 호출자가 한다.

### 입출력
```ts
interface RobotPathState {       // 입력: 활성 로봇 1대의 상태
  robotId:   string;
  pathQueue: string[];           // 다음 노드 = pathQueue[0]
  posX, posY: number | null;     // 현재 좌표(근접 판정용)
  priority:  number;             // 양보 우선권 (작을수록 먼저) — trafficPriority로 채움
  order:     number;             // 태스크 착수 시각(ms) — 우선순위 같을 때 이른 쪽 먼저(FIFO)
}
interface CollisionDecision {    // 출력: 로봇별 결정
  robotId: string;
  action:  'stop' | 'resume';
  conflictNode?: string;         // stop: 막힌 노드
  blockerId?:    string;         // stop: 우선권 가진 상대 로봇
}
```

### 평가 로직 (`evaluate(robots)`)
1. 평가 대상에 없는데 정지표시가 남은 로봇(`stoppedForNode`)을 정리.
2. 각 로봇 다음 노드(`pathQueue[0]`)의 좌표를 일괄 조회.
3. **완전순서** `goesFirst(a,b)` = `priority↑` → `order↑` → `robotId` 사전식.
4. 각 로봇 `me`에 대해, 다음 노드를 **1.5m(`NODE_PASS_M`) 이내로 점유**했거나 **같은 노드를 타겟**(`other.pathQueue[0] === nextId`)으로 하는 다른 로봇 중 `goesFirst(other, me)`인 게 있으면 → **`me` 양보(stop)**.
5. 새로 막혔으면 `stop` 결정 발행(중복 발행 안 함), 막혔다가 풀렸으면 `resume` 발행.

> **완전순서가 핵심**: priority·order·robotId까지 내려가면 동률이 없어, 두 로봇이 서로 양보하는 **정면 교착(deadlock)이 구조적으로 불가능**. 충돌당 정확히 한 대만 멈춘다.

상태: `stoppedForNode: Map<robotId, nodeId>` + 조회 헬퍼 `isWaiting` / `getBlockedNode` / `clear`(취소·맵변경·오프라인 시 강제 정리).

---

## 3. NodeOccupancyService — 점유 추적

`node-occupancy/node-occupancy.service.ts`. 인메모리 양방향 맵.

```ts
robotToNode: Map<robotId, nodeId>   // 로봇 → 현재 점유 노드
nodeToRobot: Map<nodeId, robotId>   // 노드 → 점유 로봇 (역방향)
```

- `occupy(robotId, nodeId)` — 이전 노드 자동 해제, 같은 노드 이중점유 방어, `node_occupancy_changed` 발행.
- `release(robotId)` — 점유 해제(소켓엔 `robotId=null`).
- 조회: `getOccupant(nodeId)` · `getOccupiedNode(robotId)` · `isOccupied(nodeId)` · `snapshot()`.
- **`getOccupiedNodeIds(): Set<string>`** — 경로탐색이 제외할 점유 노드 집합. → `PathfindingService.findPath(…, occupiedNodes)`.

### 점유 생애주기
- **점유**: 노드 **도착 시점** (`checkWaypointArrival` / `onNavResult` 안에서 `occupancy.occupy`).
- **해제**: 태스크 완료·실패·취소·맵변경·오프라인 (`task-execution`·`robot-monitor`·`task-manager`의 `occupancy.release`).
- 즉 **점유는 "도착"에 묶이고 "dispatch"엔 묶이지 않는다.** dispatch 시엔 그 순간의 점유 스냅샷을 경로탐색에서 회피만 한다.

---

## 4. NodeLockService — 수동 잠금

`fms/node-lock.service.ts` (TopologyService 래퍼). **운영자가 특정 노드를 폐쇄**(점검·장애구역)하면 경로탐색이 그 노드를 회피한다(출발·목적지 예외). 자동 점유(occupancy)와 별개의 **수동 통제** 레이어.

---

## 5. trafficPriority — 양보 우선권의 단일 출처

`fms/task-priority.ts`:
```ts
export function trafficPriority(t) { return -typePriority(t); }  // 큐 정렬 TYPE_PRIORITY 부호 반전
```
CollisionAvoidance는 "값이 작을수록 먼저 통과" 규약 → TYPE_PRIORITY(클수록 중요)를 반전:

| 태스크 유형 | TYPE_PRIORITY | trafficPriority | 통행 우선권 |
|---|---|---|---|
| RECALL / PAUSE | 20 | **-20** | 최우선 |
| PROCESS(구호) | 10 | -10 | |
| MOVE / SUPPLY | 5 | -5 | |
| CHARGE | 1 | -1 | 최후순위 |
| (미상) | 0 | 0 | |

> 큐 정렬(어떤 작업 먼저 배차)과 교차점 양보(어떤 로봇 먼저 통과)가 **같은 출처(TYPE_PRIORITY)**를 쓴다 — 정책 통일.

---

## 6. checkNodeConflicts — 2초 tick 통합 (`task-execution.service.ts`)

`TaskManagerService`의 2초 tick이 `monitor.syncOnlineStatus()` 직후 호출(자동 디스패치보다 먼저).

```
checkNodeConflicts():
  1) 활성 로봇 수집: RobotTaskQueue.activeEntries() 순회
       종료(terminal)·SUSPENDED 제외 → RobotPathState 빌드
         pathQueue = task.pathQueue
         posX/posY = RobotState 캐시
         priority  = trafficPriority(task)
         order     = task.startedAt(ms)   # FIFO
  2) collision.evaluate(states) 호출
  3) 결정 적용:
       stop   → cancelNav(실TB3 nav 취소) + hardStop(cmd_vel=0) + Alert.info("양보 정지")
       resume → resumePlan(taskId)  # 현재 rosCursor 스텝(goal_pose) 재전송 → 멈춘 지점부터 재주행
```

- **정지**는 navigate_to_pose 취소 + cmd_vel 0 발행(테스트봇은 moving=false). **재출발**은 같은 스텝을 다시 보내는 것이라 진행 손실 없음.
- 서버(소켓) 없으면 즉시 return — 표시 대상이 없으면 평가 스킵.

---

## 7. 통신 구조

| 방향 | 채널 | 내용 |
|---|---|---|
| **다운링크** (정지/재출발) | `/{robot}/cmd_vel`(0) · navigate_to_pose 취소 · `/{robot}/goal_pose`(재전송) | 충돌 결정 실행 |
| **업링크** (입력) | `/{robot}/amcl_pose` → RobotState 캐시 | 근접 판정용 좌표 |
| **프론트** (시각화) | 소켓 `node_occupancy_changed {node_id, robotId}` | 점유 현황 실시간 표시 |

- **동기**: tick 내 `evaluate`는 동기 의사결정. **비동기**: 로봇은 발행된 cmd_vel/goal에 비동기로 반응.
- 로봇 간 직접 통신 없음 — 모든 조정은 백엔드 tick 경유.

---

## 8. 예시 — 두 로봇이 같은 노드(N2)로

```
t0  A(MOVE, 먼저 착수) 경로 […,N2,…] · B(MOVE, 늦게 착수) 경로 […,N2,…]
t2  tick: 둘 다 다음 노드 N2. goesFirst → A.order < B.order ⇒ A 우선
        decision: B stop  → hardStop(B), "B 양보 정지 — N2 (우선: A)"
t5  A가 N2 도착 → occupancy.occupy(A, N2)
t6  tick: B 다음은 여전히 N2, A가 점유/이탈 여부로 재평가
t8  A가 N2 이탈·태스크 진행 → occupancy.release(A)
t9  tick: B 우선권 확보 → resume → resumePlan(B) goal_pose 재전송, B 재주행
```

---

## 9. 설계 노트 / 한계

- **예약 없음**: 경로는 dispatch 때 1회 계산(당시 점유/잠금 회피). 이후 충돌은 런타임 양보로만 해결 → 가볍지만, dispatch 후 새로 점유된 노드는 **양보(정지)**로 처리(재경로 아님).
- **점유 = 도착 시점**: dispatch가 아니라 노드 도착에 점유가 묶여, "가는 중"인 노드는 occupancy엔 안 잡히고 **1.5m 근접 판정 + 같은-타겟 판정**으로 커버.
- **1-ahead**: 두 칸 앞이 아니라 **바로 다음 노드 1개**만 평가.
- RMF식 트래픽 스케줄/형식 예약이 아니라, Dijkstra 경로 + 태스크 디스패치 위에 얹은 **경량 충돌 회피 오버레이**.
- 연동 문서: 태스크 생애주기·우선순위 `FMS_TASK_MANAGER.md`, ROS 도메인 통신 `FMS_DOMAIN_BRIDGE.md`.
