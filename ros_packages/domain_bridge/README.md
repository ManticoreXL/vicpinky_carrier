# Domain Bridge & rosbridge — ROS 동작 구조 문서

> 로봇(각자 다른 `ROS_DOMAIN_ID`)과 허브(관제탑, 도메인 49)·웹 대시보드를 잇는 브리지 계층 설명서.
> 실행 스크립트·설정 파일·데이터 경로를 한곳에 정리한다.

---

## 0. 현재 구성 (요약)

- **각 로봇 1개 통합 yaml** + **단일 domain_bridge 프로세스**가 기본 형태다.
  (uplink+downlink 를 한 파일에 담고, 한 프로세스가 양방향을 모두 중계)
- 과거에 tb3_01 을 `_up`/`_down` 으로 나누고 downlink 를 `--wait-for-publisher false`
  별도 프로세스로 띄우는 실험이 있었으나 **통합 형태로 복원**했다. (분리 재도입 금지)

---

## 1. 출발점: `ROS_DOMAIN_ID` = DDS 격리벽

ROS2 는 DDS 위에서 돈다. **같은 `ROS_DOMAIN_ID` 를 가진 노드끼리만** 서로 발견(discovery)하고
통신한다. 도메인 ID 는 사실상 DDS 가 쓰는 UDP 포트 묶음을 가르는 칸막이라서,
**도메인 41 의 `/odom` 은 도메인 49 에서 아예 보이지 않는다.**

| 로봇 | vicpinky | tb3_01 | tb3_02 | tb3_03 | tb3_04 | omx | **허브(관제탑)** |
|---|---|---|---|---|---|---|---|
| `ROS_DOMAIN_ID` | 40 | 41 | 42 | 43 | 44 | 45 | **49** |

각 로봇은 자기 도메인 안에서 **네임스페이스 없이** `/odom`, `/cmd_vel`, `/scan`, `/amcl_pose` 를
발행한다(로봇 여러 대가 다 `/odom` 을 써도 도메인이 달라 안 부딪침). 이 칸막이를 넘겨 허브(49)로
모아주는 게 domain_bridge 다.

(로봇 쪽 도메인 설정은 `robot_env.sh` — `source robot_env.sh tb3_01` → `ROS_DOMAIN_ID=41`.)

---

## 2. domain_bridge 의 동작 (ROS 관점)

### 2.1 브리지의 실제 동작
`domain_bridge` 는 **한 프로세스 안에서 여러 도메인에 동시에 들어가는** 노드다
(도메인마다 별도의 DDS participant 생성). 설정된 토픽 하나당:

1. `from_domain` 쪽에 **구독자(subscriber)** 를 만든다
2. `to_domain` 쪽에 **발행자(publisher)** 를 만든다
3. from 에서 받은 메시지를 to 로 **그대로 복사 재발행**하며, `remap` 으로 이름을 바꾼다

```
업링크 예:   /odom @도메인41          ──[bridge]──▶  /tb3_01/odom @도메인49
다운링크 예:  /tb3_01/cmd_vel @도메인49 ──[bridge]──▶  /cmd_vel @도메인41
```

> 브리지는 메시지 내용을 해석하지 않고 **직렬화된 바이트를 중계**한다. 그래서 **메시지 타입을
> 알아야** 하며, 타입을 못 찾으면 그 토픽 브리지가 로드 실패 → 심하면 프로세스가 죽는다.
> (워크스페이스 install 들을 전부 source 하는 이유 — §4 참고.)

### 2.2 방향(업/다운링크)은 그냥 `from`/`to` 의 차이
- **업링크**(로봇→허브, 상태/센서): `from_domain: 41, to_domain: 49`
- **다운링크**(허브→로봇, 명령): `from_domain: 49, to_domain: 41`

방향만 뒤집은 똑같은 메커니즘이라 **파일 하나(프로세스 하나)가 양방향을 다 처리**한다.

### 2.3 QoS 매칭 & `--wait-for-publisher`
DDS 는 발행자/구독자의 **QoS(reliability·durability 등)가 호환돼야** 연결된다.

- **기본값 `--wait-for-publisher true`** → 브리지가 `from_domain` 에 **발행자가 뜰 때까지
  기다렸다가** 그 발행자의 QoS 를 읽어 **자동으로 맞춘다.**
  - **업링크**: 로봇 발행자(`/odom` 등)가 **상시** 떠 있어 자동 감지가 즉시 동작
    (scan=BEST_EFFORT, amcl_pose=TRANSIENT_LOCAL 등 알아서 매칭).
  - **다운링크**: 발행자가 허브(백엔드)인데 명령(`goal_pose` 등)을 **간헐 발행** → 첫 발행 전까지
    다리가 안 설 수 있다. 다만 한 번 서면 유지되므로 통합 형태로도 보통 문제없다.
- yaml 의 `qos:` 블록은 자동 감지를 끄고 **명시적으로 지정**할 때 쓴다.
  예: tb3_01 `/map` 을 `transient_local` 로 둬 허브가 늦게 붙어도 최신 맵을 latch 로 받게 함.

### 2.4 서비스 / 액션
- **서비스**(`line_trace`, `deploy` 등): 토픽이 아니라 **서버 유무** 기준으로 다리가 선다.
  `from:49→to:41` 이면 허브에 서비스 창구를 만들고 호출을 로봇(41)의 실제 서버로 전달.
  (`--wait-for-publisher` 는 토픽 전용이라 서비스엔 무관)
- **액션**(`navigate_to_pose`, `ramp_control`): 내부적으로 서비스 3 + 토픽 2 로 구성되는데
  domain_bridge 0.5.0 의 `actions:` 섹션이 **5개를 통째로** 중계한다.
  `from:49(허브=클라이언트)→to:41(로봇=서버)`.

---

## 3. 전체 데이터 경로 (domain_bridge ↔ rosbridge)

"rosbridge" 는 **두 개의 다른 것**이다 (헷갈리기 쉬움):

```
[로봇 tb3_01]  ROS_DOMAIN_ID=41
   /odom /amcl_pose /scan /battery_state ...   (네임스페이스 없음)
        │  DDS (도메인 41)
        ▼
┌──────────────────────────────────────────────┐
│ domain_bridge   ← start_domain_bridge.sh (허브) │  ❶ 도메인↔도메인 (DDS↔DDS)
│ 도메인 40·41·42·43·44·45  ↔  49  동시 참여      │
│   /odom@41         ─remap▶ /tb3_01/odom@49      │ (업링크)
│   /tb3_01/cmd_vel@49 ─remap▶ /cmd_vel@41        │ (다운링크)
└──────────────────────────────────────────────┘
        │  DDS (도메인 49)
        ▼
┌──────────────────────────────────────────────┐
│ rosbridge_server  ← ros2 launch ... (:9090)     │  ❷ ROS2↔WebSocket(JSON)
│ 허브, ROS_DOMAIN_ID=49                          │
└──────────────────────────────────────────────┘
        │  WebSocket  ws://<허브>:9090
        ▼
   web_back (NestJS :3001)  ◀─▶  web_front (React :3000)
```

- **❶ domain_bridge** = DDS 도메인 사이를 잇는 다리 (로봇 도메인 ↔ 49)
- **❷ rosbridge_server**(rosbridge_suite) = ROS2(도메인 49) ↔ WebSocket(JSON) 변환기.
  웹이 ROS 를 직접 못 쓰니 9090 으로 노출.
- **둘 다 허브(도메인 49)에서 돌고, 49 에서 만난다.** domain_bridge 가 로봇 데이터를 49 로
  끌어오면 rosbridge_server 가 웹으로 내보낸다. 명령은 역방향.

---

## 4. 켤 때 관련되는 파일 전체 맵

### A. `domain_bridge` 켜기 — `./start_domain_bridge.sh`
실행 위치: **허브 PC** (스크립트가 도메인을 직접 지정하므로 셸의 `ROS_DOMAIN_ID` 는 무관)

| 단계 | 파일/리소스 | 역할 |
|---|---|---|
| 진입점 | `ros_packages/domain_bridge/start_domain_bridge.sh` | 전체 실행 스크립트 |
| source | `/opt/ros/jazzy/setup.bash` | ROS2 본체 |
| source | `install/setup.bash` (최상위 WS) | `vicpinky_carrier_interfaces`(RampState/RampControl/MarkerTrace) 타입 |
| source | `rosbridge/install/setup.bash` | `turtlebot_state_msgs`(LineTrace/Deploy) 타입 |
| env | `ros_packages/dds_config/fastdds_unicast.xml` | FastDDS 유니캐스트 피어 설정(멀티캐스트 안 되는 LAN용) |
| 설정 yaml ×6 | `domain_bridge_vicpinky.yaml`(40)·`_tb3_01`(41)·`_tb3_02`(42)·`_tb3_03`(43)·`_tb3_04`(44)·`_omx`(45) | 도메인별 브리지 규칙(↔49) |
| 바이너리 | `ros2 run domain_bridge domain_bridge` | 설치된 domain_bridge 패키지 |

> 직접 안 켜지는 파일: `robot_env.sh`(로봇 쪽에서 도메인 set 할 때 source),
> `domain_bridge.yaml`(구버전 통합본 — start 스크립트 미사용/레거시).

### B. `rosbridge` 켜기 — `ros2 launch rosbridge_server rosbridge_websocket_launch.xml`
실행 위치: **허브, `ROS_DOMAIN_ID=49`**

| 항목 | 파일/리소스 | 역할 |
|---|---|---|
| 런치 | `rosbridge_server`(rosbridge_suite) 패키지의 `rosbridge_websocket_launch.xml` | **repo 밖**, apt/rosdep 설치. ws:9090 |
| source(같은 셸) | `/opt/ros/jazzy/setup.bash` + `install/setup.bash` + `rosbridge/install/setup.bash` | 커스텀 타입을 JSON 으로 주고받으려면 필요 |
| 클라이언트(웹) | `web_back/src/ros/ros.service.ts`(`ROSBRIDGE_URL`), `web_front/src/config.ts`·`hooks/useRos.ts` | 9090 에 붙는 쪽 |

### C. `rosbridge/` 워크스페이스 — 빌드해서 타입/노드를 공급 (`colcon build` → `rosbridge/install`)
| 패키지 | 내용 | 어디서 쓰나 |
|---|---|---|
| `rosbridge/src/turtlebot_state_msgs` | `srv/Deploy.srv`, `srv/LineTrace.srv` | 브리지가 line_trace/deploy 중계할 때 타입 |
| `rosbridge/src/turtlebot_state` | `deploy_server.py` | **로봇에서** `/deploy` 서비스 서버로 실행(직진 후 정지) |
| `rosbridge/src/vicpinky_carrier_interfaces` | `MarkerTrace.action`·`RampControl.action`·`RampState.msg` | vicpinky 램프/마커 타입 |

---

## 5. 실행 순서 (요약)

1. **로봇 쪽**: `source robot_env.sh <robot_id>` → bringup (자기 도메인에서 발행)
2. **허브 쪽**: `./start_domain_bridge.sh` (로봇 도메인 ↔ 49 중계)
3. **허브 쪽**: `ros2 launch rosbridge_server rosbridge_websocket_launch.xml` (49 ↔ ws:9090)
4. **웹 스택**: `web_back`(:3001) + `web_front`(:3000) 이 9090 에 접속
