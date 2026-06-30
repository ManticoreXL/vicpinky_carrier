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
 omx(45)
   │  DDS                         │ DDS(49)            │ JSON/WS        │
   └──────── 도메인 브릿지 ────────┘                    └── RosService ──┘
```

- **로봇 ↔ domain_bridge**: 로봇 도메인(40~45)에서 DDS.
- **domain_bridge ↔ rosbridge**: 허브 도메인 49에서 DDS. 브릿지가 양쪽 도메인에 동시 가입해 중계.
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
    qos:                        # 선택 — 미지정 시 publisher QoS 자동 매칭
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

---

## 4. 브릿지되는 토픽 (yaml 기준)

> 6개 로봇 각 1개 yaml(uplink+downlink 통합). 아래는 현재 yaml에 정의된 주요 항목.

### 터틀봇 tb3_01~04 (도메인 41~44)
| 방향 | 로봇측 | 허브측(remap) | 타입 |
|---|---|---|---|
| ⬆ UP | `/odom` | `/{r}/odom` | `nav_msgs/Odometry` |
| ⬆ UP | `/amcl_pose` | `/{r}/amcl_pose` | `geometry_msgs/PoseWithCovarianceStamped` |
| ⬆ UP | `/battery_state` | `/{r}/battery_state` | `sensor_msgs/BatteryState` |
| ⬆ UP | `/imu` | `/{r}/imu` | `sensor_msgs/Imu` |
| ⬆ UP | `/plan` | `/{r}/plan` | `nav_msgs/Path` |
| ⬆ UP | `/map` | `/{r}/map` | `nav_msgs/OccupancyGrid` (QoS `transient_local`, SLAM 리더만) |
| ⬇ DOWN | `/cmd_vel` | `/{r}/cmd_vel` | `geometry_msgs/TwistStamped` |
| ⬇ DOWN | `/goal_pose` | `/{r}/goal_pose` | `geometry_msgs/PoseStamped` |
| ⬇ DOWN | `/initialpose` | `/{r}/initialpose` | `geometry_msgs/PoseWithCovarianceStamped` |
| ⬇ DOWN (action) | `/navigate_to_pose` | `/{r}/navigate_to_pose` | `nav2_msgs/action/NavigateToPose` |
| ⬇ DOWN (service) | `/line_trace` | `/{r}/line_trace` | `turtlebot_state_msgs/srv/LineTrace` |

> 변형: tb3_03은 `/map`을 **다운링크**(네비 전용, latched). `/victim/report`(구호 보고)·`/speak_cmd`·`/headlight_cmd` 등 로봇별 추가 항목은 각 yaml 참조.

### vicpinky 캐리어 (도메인 40)
| 방향 | 토픽 | 타입 |
|---|---|---|
| ⬆ UP | `/vicpinky/odom` · `/vicpinky/scan(_filtered)` · `/vicpinky/joint_states` | nav/sensor_msgs |
| ⬆ UP | `/ramp_state` → `/vicpinky/ramp_state` | `vicpinky_carrier_interfaces/msg/RampState` |
| ⬇ DOWN | `/vicpinky/cmd_vel` → `/cmd_vel` | `geometry_msgs/Twist` (⚠ Twist**Stamped 아님**) |
| ⬇ DOWN (action) | `/ramp_control` | `vicpinky_carrier_interfaces/action/RampControl` |

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

- 기본 `--wait-for-publisher`: 기동 시 원본 publisher를 기다려 **그 QoS를 자동 매칭**.
- 명시 지정 예) `/map`은 `durability: transient_local`(latched)로 후발 구독자도 지도 수신.
- `/scan` 등은 통상 `best_effort`로 자동 매칭.

---

## 6. 실행 / 런치

### 브릿지 (허브) — `start_domain_bridge.sh`
```bash
# 1) ROS2 + 커스텀 메시지 워크스페이스 source (vicpinky_carrier_interfaces, turtlebot_state_msgs)
# 2) FastDDS 유니캐스트 설정(멀티캐스트 차단 환경 대비): dds_config/fastdds_unicast.xml
# 3) 6개 yaml을 하나의 프로세스로 로드:
ros2 run domain_bridge domain_bridge \
  domain_bridge_vicpinky.yaml domain_bridge_tb3_01.yaml … domain_bridge_omx.yaml
```
→ 한 프로세스가 도메인 40~45 **및** 49에 동시 가입, 로봇별 pub/sub 쌍 유지.

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
| `ros.service.ts` | rosbridge(`ws://localhost:9090`) 연결, `SUBSCRIBED_TOPICS` 구독, `publish()` 발행 |
| `domain-bridge/domain-bridge.parser.ts` | `ros_packages/domain_bridge/*.yaml` 파싱 → 로봇별 `{telemetry[], commands[]}` 추출 |
| `domain-bridge/domain-bridge.service.ts` | 파싱 결과(BridgeMap) 제공 — 어떤 토픽/액션이 실제 배선됐는지 |

→ 브릿지 yaml이 **"무엇이 실제로 연결됐는지"의 단일 출처**가 되고, 백엔드(및 AI/RAG)가 이를 읽어 배선 현황을 안다.

---

## 8. 요약표

| 구성요소 | 역할 | 도메인 | 포트 | 설정 |
|---|---|---|---|---|
| 로봇 (tb3/vicpinky/omx) | 센서·구동 | 40~45 | — | `robot_env.sh` |
| **domain_bridge** | DDS↔DDS 중계 | 40~45 + 49 | — | `domain_bridge_*.yaml` ×6 (1 프로세스) |
| rosbridge_server | DDS↔WebSocket | 49 | 9090 | rosbridge_suite (외부) |
| web_back | 명령 디스패치·로깅 | — | 3001 | `ros.service.ts`, `domain-bridge.parser.ts` |
| web_front | 관제 UI | — | 3000 | `config.ts` (`ws://<host>:9090`) |
| FastDDS 설정 | 유니캐스트 피어 | — | — | `dds_config/fastdds_unicast.xml` |
