# web_back 테스트 사용설명서

FMS 백엔드 테스트는 **두 종류**다. 목적·실행법·의존성이 다르니 구분해서 쓴다.

| | 단위(Unit) | e2e(통합) |
|---|---|---|
| 위치 | `src/**/*.spec.ts` | `test/**/*.e2e-spec.ts` |
| 실행 | `npm run test` | `npm run test:e2e` |
| jest 설정 | `package.json`의 `jest` 키 (`rootDir: src`, `testRegex: .*\.spec\.ts$`) | `test/jest-e2e.json` (`rootDir: .`, `testRegex: .e2e-spec.ts$`) |
| MongoDB | **불필요** (의존성 목으로 대체) | **필요** (실제 mongod) |
| ROS / 하드웨어 | 불필요 | 불필요 (백엔드 **내장 가상 테스트봇**으로 시뮬레이션) |
| 속도 | 빠름(~1초) | 느림(~40초, 실제 주행 시뮬) |
| 무엇을 보나 | 서비스 **로직** (분기·계산·결정) | **파이프라인 전체** (DB→할당→주행→완료) |

> `npm run test`는 `src/` 아래 `*.spec.ts`만 돈다. `test/`의 `*.e2e-spec.ts`는 **절대 잡히지 않으며** `npm run test:e2e`로만 실행된다.

---

## 1. 빠른 실행

```bash
cd web_back

# 단위 테스트 (Mongo 불필요) — CI/평소 검증용
npm run test                       # 전체
npx jest task-planner.service           # 파일명 필터
npm run test:cov                    # 커버리지

# e2e (MongoDB 필요) — 실제 주행 시뮬 검증용
npm run test:e2e -- fms-pipeline --runInBand --forceExit
npm run test:e2e -- charging      --runInBand --forceExit
```

**e2e는 `--runInBand --forceExit`를 권장**한다:
- `--runInBand`: 직렬 실행. e2e가 각자 mongod에 붙고 가상로봇 tick 루프를 돌리므로 병렬이면 서로 간섭한다.
- `--forceExit`: 앱의 tick 루프·ROS 타이머·mongoose 커넥션이 핸들을 잡고 있어 테스트가 끝나도 jest가 안 닫힌다("worker failed to exit gracefully"). 강제 종료로 즉시 끝낸다.

---

## 2. 사전 준비 — MongoDB (e2e만)

로컬 mongod가 `127.0.0.1:27017`에 떠 있어야 한다.

```bash
pgrep -x mongod >/dev/null && echo "mongod OK" || sudo systemctl start mongod
```

- e2e는 **전용 DB**를 쓴다(앱 기본 `ros_dashboard`와 분리): `fms-pipeline`→`fms_verify`, `charging`→`fms_charge_verify`.
- 각 스위트 `beforeAll`에서 `dropDatabase()`로 깨끗이 시작하므로 **운영 데이터에 영향 없다**.
- 트랜잭션 미지원(단일 노드 mongod)이어도 정상 — `ChargingService`가 조건부 잠금(`tryReserveCharger`)만으로 원자성을 보장한다.

---

## 3. 단위 테스트 (`src/**/*.spec.ts`)

NestJS DI/Mongo 없이 **서비스를 직접 인스턴스화**하고 의존성을 손수 만든 jest 목으로 대체한다. FMS 4대 기능을 커버한다:

| 기능 | 파일 | 핵심 |
|---|---|---|
| ① 태스크 할당 | `fms/dispatch/task-planner.service.spec.ts` (`process — 태스크 할당`) | 지정/큐적재/오프라인/claimed/`'null'`문자열/stale |
| ② 적합 로봇 선정 | 〃 (`적합 로봇 선정`) | robotKind·canHandle·batteryOk(경계 20%)·배열순 선정·지정할당 필터우회 |
| ③ 충돌/데드락 회피 | `collision-avoidance/collision-avoidance.service.deadlock.spec.ts` | **완전순서 → 정지는 항상 1대**(둘 다 정지 불가=데드락 없음), 타이브레이크, resume, 근접충돌 |
| ④ 자동 충전 | `fms/charging/charging.service.spec.ts` | 최근접 예약·경쟁패배 폴백·점유시 배터리최대 이동·위치불명 거부 |

(추가로 `collision-avoidance.service.spec.ts`(기존), `app.controller.spec.ts`.)

### 단위 목(mock) 패턴 (이게 캐노니컬)
```ts
// 1) 서비스를 new 로 직접 생성, 의존성은 손수 만든 스텁
const svc = new TaskPlannerService(fms, robotService, robotState, robotTasks,
                                globalQueue, events, supplyHandler, navHandler);
// 2) 각 의존성은 jest.fn 으로 필요한 메서드만
const robotState = { entries: jest.fn(() => freshMap().entries()), getCache: jest.fn(...) };
// 3) events.hasServer 는 getter
const events = { get hasServer(){return true}, server:{emit:jest.fn()}, emit:jest.fn(), broadcast:jest.fn() };
// 4) 상태/타입 enum 은 실제 모듈에서 import (목 금지)
import { TaskStatus, TaskType } from '../task.schema';
import { RobotStatus }          from '../../robot/robot.schema';
// 5) it() 마다 새 svc + 새 스텁 (인메모리 상태 누수 방지)
```
- `RobotStateService.entries()`는 **호출마다 새 iterator**를 반환해야 한다(`process()`가 여러 번 소비).
- `RobotCache.lastSeen`은 number. `lastSeen: 0`을 주면 stale(오프라인)로 만들 수 있다.
- private 메서드(`canHandle` 등)는 `(svc as any).canHandle(...)`로 직접, 또는 `process()` 경유로 검증.

---

## 4. e2e 테스트 (`test/**/*.e2e-spec.ts`)

`Test.createTestingModule({ providers:[...전 서비스...] })`로 **실제 FMS 모듈을 통째로 부팅**하고, 백엔드 **내장 가상 테스트봇**(`VirtualRobotService`, `TEST-BOT1~4`)이 rosbridge 없이 amcl_pose/odom/battery를 주입하고 goal_pose를 가로채 직선 주행을 시뮬레이션한다 → 실제 로봇과 **동일한 코드 경로**를 탄다(항상 도착 성공).

| 파일 | 검증 시나리오 |
|---|---|
| `fms-pipeline.e2e-spec.ts` | 온라인 감지 · 경로탐색→할당→주행→완료(N1→N3) · 로봇별 큐 순차실행 · **노드 잠금→우회 재경로(N2잠금→N4)** |
| `charging.e2e-spec.ts` | 최근접 충전소 예약→도착 CHARGING · **동시요청 원자적 예약**(둘이 같은 충전소 점유 안 함) · 빈곳없으면 배터리최대 점유소로 · 점유현황 조회 · 수동해제 · **충전 할당 실패 시 예약 자동해제** |

### e2e 작성 규칙
- 소켓 서버가 없으면 dispatch가 멈추므로 `tm.setServer({ emit(){} } as any)`로 no-op 주입.
- 비동기 주행은 폴링으로 기다린다: `await waitFor(async () => (await fms.getTask(id))?.status === COMPLETED, 40_000, '라벨')`.
- 토폴로지(노드/엣지)는 `beforeAll`에서 `topo.createNode/createEdge`로 시드.
- **로봇 위치 필드 주의**: `lastNode` = 현재 **노드**(주행하며 `updateNode`가 갱신), `location` = **map id**(초기위치 설정 시). 도착 노드를 검증하려면 `robot.lastNode`를 본다. (`location`은 노드가 아니다)

---

## 5. 새 테스트 추가하기

**단위**: `src/<feature>/<svc>.spec.ts`로 만들면 `npm run test`가 자동으로 잡는다. 위 4번 목 패턴을 복사.

**e2e**: `test/<name>.e2e-spec.ts`로 만들고 `*.e2e-spec.ts` 규칙을 지킨다. **테스트하려는 서비스가 생성자에서 다른 서비스를 주입받으면 그 서비스도 `providers` 배열에 추가**해야 한다(안 그러면 `Nest can't resolve dependencies ...` 부팅 실패).

> 실제로 이 함정에 걸렸었다: `SupplyTaskHandler`에 `SupplyVisionService`가 생성자 인자로 추가됐는데 e2e `providers`에 빠져 있어 모듈 부팅이 실패. 생성자 바꾸면 e2e providers도 같이 갱신할 것.

---

## 6. 함정(gotchas) 정리

- `npm run test`에 e2e가 안 잡힌다 → 정상. e2e는 `npm run test:e2e`.
- e2e가 안 끝나고 매달림 → `--forceExit`(앱 tick/ROS/mongoose 핸들 누수).
- e2e가 부팅에서 `Nest can't resolve dependencies` → `providers` 배열에 빠진 서비스 추가.
- e2e가 `location` 단언으로 실패 → 노드는 `lastNode`, `location`은 map id.
- e2e 병렬 실행 시 DB 충돌 → `--runInBand` + 스위트별 전용 DB 사용 중.
- 선재 tsc 경고 2건(`scripts/dump-ros-bridge.ts` 없는 모듈, `fms-pipeline.e2e-spec.ts`의 `app.get<Connection>` untyped generic)은 실행을 막지 않는다(ts-jest는 그대로 통과).
