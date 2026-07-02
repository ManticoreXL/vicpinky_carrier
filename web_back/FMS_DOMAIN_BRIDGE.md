# FMS Domain Bridge — ROS2 도메인 통신 구조 (현재 코드 기준)

> 중앙 관제(허브)와 이기종 로봇들이 **서로 다른 DDS 도메인**에 격리돼 있을 때, 이를 잇는 ROS2 `domain_bridge` 계층을 정리한 문서.
> 위치: `ros_packages/domain_bridge/` (yaml·스크립트) + `web_back/src/ros/domain-bridge/` (백엔드 파서).
> 연동 문서: 태스크 매니저 `FMS_TASK_MANAGER.md`, 교통 관리 `FMS_TRAFFIC_MANAGER.md`.

---

## 0. 왜 필요한가 — DDS 도메인 격리

ROS2는 DDS로 디스커버리/통신하며, **`ROS_DOMAIN_ID`가 다른 노드는 서로 보이지 않는다.** 로봇마다 자기 도메인을 써서:
- 각 로봇이 `/odom`·`/cmd_vel` 같은 동일 토픽명을 **충돌 없이** 사용.
- 허브(도메인 49)는 모든 로봇과 통신해야 함.

`domain_bridge`는 **여러 도메인에 동시에 가입**해 메시지를 도메인 간 그대로 중계(이름 remap + 직렬화 복사)한다. 상태 없음(stateless).

---

## 1. 도메인 맵 (`robot_env.sh`)

| 구성요소 | vicpinky | tb3_01 | tb3_02 | tb3_03 | tb3_04 | omx | **허브(서버)** |
|---|---|---|---|---|---|---|---|
| `ROS_DOMAIN_ID` | 40 | 41 | 42 | 43 | 44 | 45 | **49** |

로봇 측: `source robot_env.sh <robot_id>` → 해당 `ROS_DOMAIN_ID` export 후 로봇 노드 기동.

---

## 2. 전체 통신 체인

```
[로봇 노드들]                 [허브 PC]
 vicpinky(40)                domain_bridge ── rosbridge_server ── web_back ──(HTTP/WS)── web_front
 tb3_01(41) … tb3_04(44)     (40~45 + 49 동시가입)   :9090(WS)    NestJS :3001          React :3000
 omx(45)                     action_relay.py
   │  DDS                    (40~44 ↔ 49, 액션/서비스만)
   └──────── 도메인 브릿지 ────┤ DDS(49)            │ JSON/WS        │
                              └── RosService ──┘
```

- **로봇 ↔ domain_bridge**: 로봇 도메인(40~45)에서 DDS. **토픽만** 중계한다(아래 3번 참고).
- **로봇 ↔ action_relay.py**: 액션·서비스 전용 별도 프로세스. domain_bridge와 나란히 떠서 40~44↔49를 중계한다.
- **domain_bridge/action_relay.py ↔ rosbridge**: 허브 도메인 49에서 DDS.
- **rosbridge ↔ web_back**: WebSocket `ws://localhost:9090` (rosbridge_suite, 외부 패키지). 웹은 DDS를 직접 못 하므로 **유일한 ROS2↔WebSocket 변환점**.
- **web_back ↔ web_front**: HTTP(`:3001`) + Socket.IO. 프론트는 `ws://<host>:9090`로 rosbridge에도 직접 구독 가능(`web_front/src/config.ts`).

---

## 3. yaml 스키마 (`domain_bridge_<robot>.yaml`)

```yaml
name: domain_bridge_tb3_01
topics:
  /<허브측-키 또는 로봇측-키>:
    type: <message/type>        # 필수 — 타입 못 찾으면 그 항목 브릿지 실패
    from_domain: <int>          # 출발 도메인
    to_domain:   <int>          # 도착 도메인
    remap: <상대측-토픽명>        # 선택 — 키와 다르면 지정
    qos:                        # 선택 — 미지정 시 기본값(5번 참고. reliability/durability만 auto, history/depth는 고정 keep_last/10)
      reliability: reliable | best_effort
      durability:  transient_local | volatile
      history: keep_last
      depth: <int>
services:  { … 동일 구조 … }
actions:   { … 동일 구조 … }
```

**방향 규칙**:
- **UPLINK**(로봇→허브): `to_domain == 49`. 로봇이 `key`로 발행 → 허브가 `remap`으로 수신. 예) `/odom`(41) → `/tb3_01/odom`(49).
- **DOWNLINK**(허브→로봇): `from_domain == 49`. 허브가 `key`로 발행 → 로봇이 `remap`으로 수신. 예) `/tb3_01/cmd_vel`(49) → `/cmd_vel`(41).

> ⚠ **`services:`/`actions:` 섹션은 domain_bridge가 실제로 처리하지 않는다.** 설치된 `ros-jazzy-domain-bridge`(0.5.0)는
> `topics:`만 지원하고(공식 헤더 `parse_domain_bridge_yaml_config.hpp`에도 `topics`만 문서화됨, upstream issue #11 미구현),
> 두 섹션은 조용히 무시된다. 각 yaml의 `services:`/`actions:` 블록은 그래서 **"무엇을 중계해야 하는지"를 사람이 읽는 명세**로만
> 남아있고, 실제 중계는 별도 프로세스 **`action_relay.py`**가 담당한다(6번 참고). `type`/`from_domain`/`to_domain`/`remap`
> 의미는 topics와 동일하게 읽으면 되지만, 여기 있는 항목이 실제로 살아있는지는 `action_relay.py`의 `ACTION_RELAYS`/
> `SERVICE_RELAYS` 목록에도 등록돼 있는지로 확인해야 한다 — yaml에만 있고 그 목록에 없으면 안 뚫린다.

---

## 4. 브릿지되는 토픽 (yaml 기준)

> 6개 로봇 각 1개 yaml(uplink+downlink 통합). 아래는 현재 yaml에 정의된 주요 항목.
> **`(action)`/`(service)` 표시가 붙은 행은 domain_bridge가 아니라 `action_relay.py`가 실제로 중계한다** (3번 경고 참고).

### 터틀봇 tb3_01~04 (도메인 41~44)
| 방향 | 로봇측 | 허브측(remap) | 타입 |
|---|---|---|---|
| ⬆ UP | `/odom` | `/{r}/odom` | `nav_msgs/Odometry` |
| ⬆ UP | `/amcl_pose` | `/{r}/amcl_pose` | `geometry_msgs/PoseWithCovarianceStamped` |
| ⬆ UP | `/battery_state` | `/{r}/battery_state` | `sensor_msgs/BatteryState` |
| ⬆ UP | `/imu` | `/{r}/imu` | `sensor_msgs/Imu` |
| ⬆ UP | `/plan` | `/{r}/plan` | `nav_msgs/Path` |
| ⬆ UP | `/map` | `/{r}/map` | `nav_msgs/OccupancyGrid` (QoS `transient_local`, SLAM 리더만 — tb3_01) |
| ⬇ DOWN | `/cmd_vel` | `/{r}/cmd_vel` | `geometry_msgs/TwistStamped` |
| ⬇ DOWN | `/goal_pose` | `/{r}/goal_pose` | `geometry_msgs/PoseStamped` |
| ⬇ DOWN | `/initialpose` | `/{r}/initialpose` | `geometry_msgs/PoseWithCovarianceStamped` |
| ⬇ DOWN | `/map` | `/{r}/map` | `nav_msgs/OccupancyGrid` (QoS `transient_local`, 내비 전용 — tb3_03·04만) |
| ⬇ DOWN **(action, `action_relay.py`)** | `/navigate_to_pose` | `/{r}/navigate_to_pose` | `nav2_msgs/action/NavigateToPose` |
| ⬇ DOWN **(service, `action_relay.py`)** | `/line_trace` | `/{r}/line_trace` | `turtlebot_state_msgs/srv/LineTrace` |
| ⬇ DOWN **(service, `action_relay.py`)** | `/deploy` | `/tb3_03/deploy` | `turtlebot_state_msgs/srv/Deploy` (tb3_03만) |

> 변형: `/victim/report`(구호 보고, tb3_01)·`/victim/confirmed`(정찰 확정, tb3_03)·`/speak_cmd`·`/headlight_cmd` 등 로봇별 추가 항목은 각 yaml 참조.

### vicpinky 캐리어 (도메인 40)
| 방향 | 토픽 | 타입 |
|---|---|---|
| ⬆ UP | `/vicpinky/odom` · `/vicpinky/scan(_filtered)` · `/vicpinky/joint_states` | nav/sensor_msgs |
| ⬆ UP | `/ramp_state` → `/vicpinky/ramp_state` | `vicpinky_carrier_interfaces/msg/RampState` |
| ⬇ DOWN | `/vicpinky/cmd_vel` → `/cmd_vel` | `geometry_msgs/Twist` (⚠ Twist**Stamped 아님**, QoS `reliable` 명시) |
| ⬇ DOWN **(service, `action_relay.py`)** | `/vicpinky/run_diagnosis` → `/vicpinky/run_diagnosis` | `std_srvs/srv/Trigger` |
| ⬇ DOWN **(action, `action_relay.py`)** | `/ramp_control` → `/ramp_control` | `vicpinky_carrier_interfaces/action/RampControl` |

### omx 매니퓰레이터 (도메인 45) — 공급 비전
| 방향 | 로봇측 | 허브측 | 타입 |
|---|---|---|---|
| ⬆ UP | `/vision/is_loaded` | `/omx/vision/is_loaded` | `std_msgs/Bool` (적재 감지) |
| ⬆ UP | `/vision/object_red`·`object_blue` | `/omx/vision/…` | `std_msgs/Bool` |
| ⬆ UP | `/joint_states`·`/follower_state` | `/omx/…` | `sensor_msgs/JointState` |
| ⬇ DOWN | `/omx/vision/start_red`·`start_blue` | `/vision/start_…` | `std_msgs/Bool` (추론 시작) |
| ⬇ DOWN | `/joint_commands` | `/joint_commands` | `std_msgs/Float32MultiArray` |

> 태스크 매니저 SUPPLY 흐름(`start_inference` 발행 → `is_loaded` 대기)이 이 omx 브릿지 위에서 동작.

---

## 5. QoS

`domain_bridge`의 `qos:`는 `topics:` 항목에만 적용된다(액션/서비스는 `action_relay.py`가 대신하며, 거기엔 QoS
오버라이드 개념 자체가 없다 — rclpy 기본 프로파일 그대로 중계).

**기본값**(설치된 `domain_bridge` 0.5.0, `qos_options.hpp` 기준):
- `reliability`/`durability` — 미지정 시 **auto-detect**(원본 publisher 값을 그대로 따라감).
- `history`/`depth` — 미지정이어도 **auto 아님**. 무조건 `keep_last` / **`depth: 10`** 고정값을 쓴다.
  → 원본이 `depth:1`(최신값만 유지)로 발행해도, `qos:`에 명시하지 않으면 브릿지 단계에서 `depth:10`으로 바뀐다.
  병목·지연 최소화가 목적이면 `history`/`depth`는 auto-detect되지 않는다는 점을 반드시 기억할 것.

**현재 명시 설정된 곳(4곳뿐)**:
| 파일 | 토픽 | 설정 |
|---|---|---|
| `domain_bridge_tb3_01.yaml` | `/map`(업링크) | `transient_local, reliable, keep_last, depth:1` |
| `domain_bridge_tb3_03.yaml` | `/tb3_03/map`(다운링크) | 동일 |
| `domain_bridge_tb3_04.yaml` | `/tb3_04/map`(다운링크) | 동일 |
| `domain_bridge_vicpinky.yaml` | `/vicpinky/cmd_vel`(다운링크) | `reliability: reliable`만 |

`/map`이 명시 지정된 이유: `transient_local`(latched)이어야 브릿지 기동 후 늦게 붙는 구독자도 마지막 지도를 받는다 —
auto-detect도 원본이 transient_local이면 이론상 따라가지만, 브릿지가 원본보다 먼저 뜨는 시점(publisher 미발견) 등
경합을 피하려 명시적으로 고정했다.

> ⚠ 한때(2026-06-16, `d1a6422`/`816b2bd` 커밋) `/odom`·`/battery_state`·`/imu`·`/amcl_pose`·`/plan` 등 대부분
> 토픽에 `best_effort`/`reliable` + `depth:1`을 세밀하게 지정했었으나, 같은 날 `fe95d21`(불필요 브릿지 제거)과
> 이후 리라이트를 거치며 `/map` 4곳을 제외하고 전부 제거됐다(주로 정리 과정에서 함께 빠짐). 특히
> `/tb3_0X/cmd_vel` 다운링크의 `best_effort+depth:1`은 지금 `# qos:` 주석으로만 남아있고 비활성 상태라,
> rosbridge가 만드는 publisher 기본값(대략 `reliable, depth:10`)을 그대로 auto-match해 밀린 옛 속도 명령이
> 쌓였다 순차 전달될 수 있다 — 실기체 원격 조작 지연이 체감되면 이 부분부터 확인할 것.

---

## 6. 실행 / 런치

### 브릿지 (허브) — `start_domain_bridge.sh`
```bash
# 1) ROS2 + 커스텀 메시지 워크스페이스 source (vicpinky_carrier_interfaces, turtlebot_state_msgs)
# 2) FastDDS 유니캐스트 설정(멀티캐스트 차단 환경 대비): dds_config/fastdds_unicast.xml
# 3) action_relay.py 를 백그라운드로 먼저 기동(아래 참고) — 스크립트 종료 시 trap 으로 같이 정리됨
# 4) 6개 yaml을 하나의 프로세스로 로드:
ros2 run domain_bridge domain_bridge \
  domain_bridge_vicpinky.yaml domain_bridge_tb3_01.yaml … domain_bridge_omx.yaml
```
→ domain_bridge 프로세스가 도메인 40~45 **및** 49에 동시 가입해 **`topics:`만** 중계, 로봇별 pub/sub 쌍 유지.

### 액션·서비스 릴레이 — `action_relay.py` (domain_bridge와 함께 자동 기동)
```bash
python3 ros_packages/domain_bridge/action_relay.py &   # start_domain_bridge.sh 안에서 자동 실행
```
- domain_bridge와 **동일한 환경**(워크스페이스 source + `FASTRTPS_DEFAULT_PROFILES_FILE`)이 필요 — 같은 스크립트 안에서 상속받는다.
- 각 도메인(40~44, 49)마다 독립된 rclpy `Context`+`Node`+`MultiThreadedExecutor`를 띄우고, 허브 도메인엔 서버를, 로봇 도메인엔 클라이언트를 만들어 goal/request를 그대로 프록시한다.
- `ACTION_RELAYS`/`SERVICE_RELAYS`(스크립트 상단) 목록에 없는 항목은 yaml에 있어도 중계되지 않는다 — 새 액션/서비스를 추가하려면 여기에 한 줄 추가.
- 코드를 고쳐도 **이미 떠 있는 프로세스는 재시작 전까지 반영 안 됨**(Python 특성상 hot-reload 없음). 재기동은 `SIGINT`(정상 종료 경로) 권장, `SIGKILL`은 회피.

### rosbridge (허브, 도메인 49)
```bash
export ROS_DOMAIN_ID=49
ros2 launch rosbridge_server rosbridge_websocket_launch.xml   # :9090
```

### 로봇 측
```bash
source robot_env.sh tb3_01      # ROS_DOMAIN_ID=41 + FastDDS 설정
ros2 launch turtlebot3_bringup robot.launch.py
```

### 백엔드
```bash
cd web_back && npm run start     # :3001, ws://localhost:9090 연결
```

> `dds_config/fastdds_unicast.xml`: WiFi 멀티캐스트 차단 시 피어 IP를 명시(initialPeersList). `start_domain_bridge.sh`/`robot_env.sh`가 `FASTRTPS_DEFAULT_PROFILES_FILE`로 export.

---

## 7. 백엔드 통합 (`web_back/src/ros/`)

| 파일 | 역할 |
|---|---|
| `ros.service.ts` | rosbridge(`ws://localhost:9090`) 연결, `SUBSCRIBED_TOPICS` 구독, `publish()` 발행. QoS는 지정하지 않음(3·5번 참고) |
| `domain-bridge/domain-bridge.parser.ts` | `ros_packages/domain_bridge/*.yaml` 파싱 → 로봇별 `{telemetry[], commands[]}` 추출 |
| `domain-bridge/domain-bridge.service.ts` | 파싱 결과(BridgeMap) 제공 — 어떤 토픽/액션/서비스가 실제 배선됐는지 |

→ 브릿지 yaml이 **"무엇이 실제로 연결됐는지"의 단일 출처**가 되고, 백엔드(및 AI/RAG)가 이를 읽어 배선 현황을 안다.

> ⚠ `domain-bridge.parser.ts`는 `topics:`/`actions:`/`services:` 세 섹션을 구분 없이 동일하게 파싱한다 —
> 이름·타입·방향은 정확하지만, **실제 전송 계층이 `actions:`/`services:`는 domain_bridge가 아니라
> `action_relay.py`라는 사실은 BridgeMap에 드러나지 않는다.** `action_relay.py`가 안 떠 있거나 해당
> 항목이 그 스크립트의 `ACTION_RELAYS`/`SERVICE_RELAYS`에서 빠지면, BridgeMap(및 AI 요약)은 여전히
> "연결됨"이라고 보고하지만 실제로는 죽어있는 상태가 된다 — 참고용 단일 출처일 뿐 살아있음의 보증은 아니다.

---

## 8. 요약표

| 구성요소 | 역할 | 도메인 | 포트 | 설정 |
|---|---|---|---|---|
| 로봇 (tb3/vicpinky/omx) | 센서·구동 | 40~45 | — | `robot_env.sh` |
| **domain_bridge** | DDS↔DDS **토픽** 중계 | 40~45 + 49 | — | `domain_bridge_*.yaml` ×6 (1 프로세스) |
| **action_relay.py** | DDS↔DDS **액션·서비스** 중계 (domain_bridge 미지원 대체) | 40~44 + 49 | — | 스크립트 상단 `ACTION_RELAYS`/`SERVICE_RELAYS` |
| rosbridge_server | DDS↔WebSocket | 49 | 9090 | rosbridge_suite (외부) |
| web_back | 명령 디스패치·로깅 | — | 3001 | `ros.service.ts`, `domain-bridge.parser.ts` |
| web_front | 관제 UI | — | 3000 | `config.ts` (`ws://<host>:9090`) |
| FastDDS 설정 | 유니캐스트 피어 | — | — | `dds_config/fastdds_unicast.xml` |
