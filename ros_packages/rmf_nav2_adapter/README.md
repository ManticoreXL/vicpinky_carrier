# Nav2 ↔ RMF Fleet Adapter 연결 가이드

단일 tb3(Nav2, /navigate_to_pose 전역) → RMF 연결 기준.

## 구성요소

```
0.yaml(nav graph) ─┐
config.yaml ───────┼→ fleet adapter(EasyFullControl) ─→ Nav2(/navigate_to_pose)
nav2_robot_api.py ─┘                                       ↑ tf로 위치 읽음
```

## 1. 템플릿 받기
```bash
cd ~/Desktop/slam_test/turtlebot3_ws/src
git clone https://github.com/open-rmf/fleet_adapter_template.git
# (브랜치는 설치된 RMF에 맞게: jazzy 또는 main)
```

## 2. Nav2용 RobotAPI 적용
- 템플릿의 `RobotClientAPI.py`(REST 가정)를 우리 `nav2_robot_api.py`(ROS2/Nav2)로 교체.
- 템플릿 `fleet_adapter.py`가 `RobotAPI`를 임포트/생성하는 부분을 nav2 버전으로 연결.
- ⚠️ 템플릿 버전에 따라 메서드 시그니처가 조금 다를 수 있음 → 템플릿의 원본 RobotClientAPI 메서드와 대조해서 맞추기.

## 3. config.yaml 채우기
- `name`: 함대명 (예 tb3_fleet)
- `robots.tb3.charger`: nav graph의 waypoint 이름 (예 "init")
- **`reference_coordinates`** ★: RMF 좌표(0.yaml) ↔ 로봇 map 좌표 매칭
  - nav graph를 SLAM 맵 위에 같은 스케일로 그렸으면 → 두 배열 동일하게.
  - 어긋나면: 실제 같은 지점 2~3곳을 양쪽 좌표로 측정해 입력.

## 4. nav graph 위치
- `0.yaml`을 fleet adapter launch의 `nav_graph_file` 인자로 경로 지정 (위치 자유).

## 5. 실행 순서
```bash
# (A) 로봇 bringup + Nav2 (이미 실행 중: /navigate_to_pose 떠야 함)

# (B) RMF 코어
ros2 run rmf_traffic_ros2 rmf_traffic_schedule
ros2 run rmf_task_ros2 rmf_task_dispatcher        # task manager(dispatcher)
ros2 run rmf_building_map_tools building_map_server <building.yaml>

# (C) fleet adapter
ros2 launch fleet_adapter_template fleet_adapter.launch.xml \
  config_file:=<config.yaml> nav_graph_file:=<0.yaml>
```

## 6. 작업 보내보기 (웹 없이 CLI 테스트)
```bash
ros2 run rmf_demos_tasks dispatch_patrol \
  -p init second_corner -n 1 --use_sim_time false
```
→ 로봇이 init→second_corner로 이동하면 성공. RMF가 NavigateToPose를 Nav2로 보낸 것.

## 7. 웹 연결 (이미 다리 구현됨)
- 백엔드가 `/fleet_states` 구독(웹에 함대 상태) + `/task_api_requests` 발행(작업 제출).
- FMS의 `dispatchRmfTask(...)`로 위 patrol과 동일한 작업을 웹에서 제출.

## 핵심
- RMF는 NavigateToPose만 보냄 → **Nav2가 실제 주행**.
- 좌표 정합은 **reference_coordinates** 하나로 끝.
- 여러 로봇/함대로 늘릴 땐 config의 robots에 추가 + (네임스페이스면) nav2_robot_api의 nav_action/frame을 그 네임스페이스로.
