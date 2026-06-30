# vicpinky_carrier
AI 융합 로봇 SW 개발자 2기 최종 프로젝트 (4팀)

# Turtlebot 브랜치
## 환경 설정
- Operating System: Ubuntu 24.04 LTS
- ROS2 Distribution: ROS2 Jazzy Jalisco
 
1. 가상환경 준비
    ```bash
    python3 -m venv ~/venv/ros
    ```

2. ROS2 환경 불러오기
    ```bash
    source /opt/ros/jazzy/setup.bash
    ```

3. 레포지토리 가져오기
    ```bash
    cd ~/
    git clone https://github.com/ManticoreXL/vicpinky_carrier
    ```

4. 외부 의존성 소스 로드
    ```bash
    cd ~/vicpinky_carrier
    vcs import src < turtlebot.repos
    ```

5. 의존성 패키지 설치
    ```bash
    sudo apt-get update
    pip install -r requirements.txt
    rosdep update
    rosdep install --from-paths src --ignore-src -y --rosdistro jazzy
    sudo apt install python3-pyaudio mpg123 scons build-essential python3-rpi-lgpio alsa-utils flac
    sudo pip3 install adafruit-circuitpython-neopixel-spi gTTS SpeechRecognition --break-system-packages
    ```

6. 펌웨어 컨픽 수정
    ```bash
    sudo nano /boot/firmware/config.txt
    ```
    - 파일 최하단에 다음 내용 추가
    - `dtparams=spi=on`
    - `dtparams=i2s=on`
    - `dtoverlay=googlevoicehat-soundcard`

7. 하드웨어 그룹 권한 부여
    ```bash
    sudo usermod -aG audio $USER
    sudo usermod -aG video $USER
    sudo usermod -aG plugdev $USER
    sudo usermod -aG spi $USER
    sudo usermod -aG dialout $USER
    ```

8. 환경 설정 스크립트 실행
    ```bash
    ./turtlebot.sh <BOT_ID> <BOT_IP>
    ```
    - BOT_ID는 tb3_01, tb3_02, tb3_03, tb3_04
    - BOT_IP는 Wi-Fi IP 주소 입력

9. 패키지 빌드
    ```bash
    colcon build
    ```

10. 재부팅
    ```bash
    sudo reboot now
    ```

## 실행 방법
### 탐사용 터틀봇 통합 실행
```bash
ros2 launch turtlebot_state explorer.launch.py
```

### 구호용 터틀봇 통합 실행
```bash
ros2 launch turtlebot_state rescuer.launch.py
```

## 주요 파라미터
### headlight_node.py
- led_brightness
    - Integer
    - default=50
    - LED 밝기를 0부터 100까지 값으로 제어 (최대 100)
- blink_period
    - Float
    - default=0.5
    - blink 명령 수신 시 LED 점멸 주기 (초 단위)
- blink_count
    - Integer
    - default=3
    - blink 명령 수신 시 LED 점멸 횟수

### voice_node.py
- stt_language
    - String
    - default='ko-KR'
    - Google STT 인식 언어
- tts_language
    - String
    - default='ko'
    - gTTS 합성 언어
- tts_tld
    - String
    - default='co.kr'
    - gTTS 음성 톤을 결정하는 도메인
- audio_player_cmd
    - String
    - default='mpg123 -a plughw:1,0'
    - TTS 재생에 사용할 오디오 플레이어 명령
- temp_audio_path
    - String
    - default='/tmp/tts_output.mp3'
    - TTS 임시 파일 저장 경로
- howling_delay
    - Float
    - default=0.5
    - TTS 종료 후 STT 재개까지 대기 시간 (하울링 방지, 초 단위)
- pause_threshold
    - Float
    - default=0.5
    - 발화 종료로 판단하는 묵음 길이 (초 단위)
- energy_threshold
    - Integer
    - default=200
    - 음성 인식 시작 에너지 임계값
- dynamic_energy_threshold
    - Bool
    - default=False
    - 주변 소음에 따른 에너지 임계값 자동 조정 여부

### deploy_node.py
- bot_id
    - String
    - default='tb3_01'
    - 로봇 식별자
- cmd_vel_topic
    - String
    - default=''
    - 비우면 `/{bot_id}/cmd_vel` 사용
- use_stamped
    - Bool
    - default=True
    - True면 TwistStamped, False면 Twist 발행
- base_frame
    - String
    - default='base_link'
    - 로봇 기준 좌표 프레임
- forward_speed
    - Float
    - default=0.07
    - 하차 전진 속도 (m/s)
- forward_time
    - Float
    - default=12.0
    - 하차 전진 지속 시간 (경사로+플랫폼 거리에 맞춰 조정, 초 단위)
- control_rate_hz
    - Float
    - default=20.0
    - 제어 루프 주기 (Hz)

### explorer_state_manager.py / rescuer_state_manager.py
- bot_id
    - String
    - default='tb3_01' (explorer) / 'tb3_02' (rescuer)
    - 로봇 식별자
- marker_id
    - Integer
    - default=1 (explorer) / 2 (rescuer)
    - 해당 로봇의 주차 마커 번호
- publish_rate_hz
    - Float
    - default=2.0
    - 상태(RobotState) 발행 주기 (Hz)

### reverse_line_follower.py
- bot_id
    - String
    - default='tb3_01'
    - 로봇 식별자 (속도·조향 값은 코드 내부 상수로 고정)
### victim_detector.py
- model_path
    - String
    - default='~/models/best.onnx'
    - YOLO ONNX 모델 경로
- image_topic
    - String
    - default='/image_raw/compressed'
    - 입력 압축 영상 토픽
- detections_topic
    - String
    - default='/victim/detections'
    - 검출 결과 발행 토픽
- input_size
    - Integer
    - default=320
    - 모델 입력 해상도 (best.onnx 기준)
- conf_threshold
    - Float
    - default=0.45
    - YOLO 신뢰도 임계값
- nms_iou
    - Float
    - default=0.5
    - NMS IoU 임계값
- process_interval
    - Float
    - default=0.1
    - 추론 최소 간격 (초 단위, 최대 약 10Hz)
### victim_mapper.py
- min_confirm_frames
    - Integer
    - default=6
    - 확정에 필요한 일관된 추정 프레임 수
- confirm_timeout
    - Float
    - default=6.0
    - 확정 제한 시간 (초과 시 오탐 처리, 초 단위)
- max_spread
    - Float
    - default=0.5
    - 추정 분산이 이 값을 넘으면 확정 보류 (m)
- merge_radius
    - Float
    - default=1.0
    - 이 반경 내 기존 victim은 동일인으로 병합 (m)
- max_range
    - Float
    - default=6.0
    - 이보다 먼 추정은 신뢰하지 않음 (m)
- enable_fallback
    - Bool
    - default=True
    - bbox 거리 추정 실패 시 폴백 추정 사용 여부
- csv_path
    - String
    - default='~/maps/victims.csv'
    - 확정 victim 좌표 저장 경로
### victim_obstacle_publisher.py
- victim_list_topic
    - String
    - default='/victim/list'
    - 확정 victim 좌표 입력 토픽
- obstacle_topic
    - String
    - default='/victim/obstacles'
    - costmap용 장애물 포인트 발행 토픽
- obstacle_radius
    - Float
    - default=1.0
    - victim 1명당 장애물 원 반경 (m)
- obstacle_points
    - Integer
    - default=12
    - 원형으로 생성할 점 개수
- pub_rate
    - Float
    - default=2.0
    - 장애물 발행 주기 (Hz)
### mission_coordinator.py
- map_save_path
    - String
    - default='/home/USERNAME/maps/disaster_map'
    - 미션 종료 시 맵 저장 경로
- min_frontier_size
    - Integer
    - default=8
    - 이 셀 수 미만 프론티어는 노이즈로 무시
- min_goal_distance
    - Float
    - default=0.5
    - 목표로 채택할 최소 거리 (Nav2 허용오차보다 커야 함, m)
- obstacle_clearance
    - Float
    - default=0.25
    - 목표는 장애물에서 최소 이만큼 떨어진 곳만 채택 (m)
- max_goal_attempts
    - Integer
    - default=4
    - 한 목표에 연속 실패 시 포기(블랙리스트) 횟수
- localization_lost_timeout
    - Float
    - default=60.0
    - localization 미복귀가 지속되면 미션 종료 (초 단위)
- finish_topic
    - String
    - default='/mission/finish_now'
    - 수신 시 현재 맵 저장 후 복귀하는 토픽 (std_msgs/Empty)
- inspect_timeout
    - Float
    - default=10.0
    - 확정/오탐 없을 시 자동 탐색 복귀 시간 (초 단위)
### victim_inspector.py
- goal_in_topic
    - String
    - default='/goal_pose'
    - 검사 목표 입력 토픽
- nav_action
    - String
    - default='/navigate_to_pose'
    - Nav2 액션 이름
- inspect_timeout
    - Float
    - default=10.0
    - 확정/오탐 없을 시 자동 재개 시간 (초 단위)

## 주요 토픽
> 상태 관련 토픽은 launch의 네임스페이스 적용에 따라 `/{bot_id}/...` 형태로 매핑됩니다.
 
### headlight_node.py
- Subscribe
    - `headlight_cmd` (std_msgs/String) : `on` / `off` / `blink` LED 제어 명령
### voice_node.py
- Publish
    - `recognized_text` (std_msgs/String) : STT 인식 결과
- Subscribe
    - `speak_cmd` (std_msgs/String) : TTS로 출력할 텍스트
    - `voice_mode` (std_msgs/String) : `STT` / `CALL` 동작 모드 전환
### deploy_node.py
- Publish
    - `/{bot_id}/cmd_vel` (Twist 또는 TwistStamped) : 하차 전진 속도 명령
    - `/state_update` (turtlebot_state_msgs/StateUpdate) : 단계 완료 보고
- Subscribe
    - `/robot_state` (turtlebot_state_msgs/RobotState) : 현재 로봇 상태
### explorer_state_manager.py / rescuer_state_manager.py
- Publish
    - `/robot_state` (turtlebot_state_msgs/RobotState, latched) : 로봇 상태 발행
- Subscribe
    - `/state_update` (turtlebot_state_msgs/StateUpdate) : 기능 노드의 단계 완료 보고
    - `/pc_command` (turtlebot_state_msgs/PcCommand) : PC(미션 두뇌)의 지시
    - `/vicpinky_signal` (turtlebot_state_msgs/VicpinkySignal) : 빅핑키의 LOAD/PARK 신호
### reverse_line_follower.py
- Publish
    - `/cmd_vel` (geometry_msgs/TwistStamped) : 라인트레이싱 주행 명령
- Subscribe
    - `/robot_state` (turtlebot_state_msgs/RobotState, latched) : TRACE 단계 활성화 판단
### victim_detector.py
- Publish
    - `/victim/detections` (vision_msgs/Detection2DArray) : YOLO 검출 결과
- Subscribe
    - `/image_raw/compressed` (sensor_msgs/CompressedImage) : 입력 카메라 영상
### victim_mapper.py
- Publish
    - `/victim/candidate` (std_msgs/Empty) : 검사 후보 발생 알림
    - `/victim/confirmed` (geometry_msgs/PoseStamped) : 확정 victim 좌표
    - `/victim/rejected` (std_msgs/Empty) : 오탐 처리 알림
    - `/victim/markers` (visualization_msgs/MarkerArray, latched) : RViz 시각화 마커
    - `/victim/list` (geometry_msgs/PoseArray, latched) : 확정 victim 좌표 목록
    - `/victim/report` (std_msgs/String, latched) : victim 요약 리포트
- Subscribe
    - `/victim/detections` (vision_msgs/Detection2DArray) : 검출 결과
    - `/camera_info` (sensor_msgs/CameraInfo) : 카메라 내부 파라미터
### victim_obstacle_publisher.py
- Publish
    - `/victim/obstacles` (sensor_msgs/PointCloud2, latched) : costmap용 장애물 포인트
- Subscribe
    - `/victim/list` (geometry_msgs/PoseArray) : 확정 victim 좌표 목록
### mission_coordinator.py
- Subscribe
    - `map` (nav_msgs/OccupancyGrid) : SLAM 맵 (프론티어 탐색용)
    - `/mission/finish_now` (std_msgs/Empty) : 미션 강제 종료 신호
    - `/victim/candidate` (std_msgs/Empty) : 검사 후보 발생
    - `/victim/confirmed` (geometry_msgs/PoseStamped) : victim 확정
    - `/victim/rejected` (std_msgs/Empty) : 오탐 처리
- Action Client
    - `navigate_to_pose` (nav2_msgs/NavigateToPose) : Nav2 목표 주행
- Service Client
    - `slam_toolbox/save_map` (slam_toolbox/SaveMap) : 맵 저장
### victim_inspector.py
- Subscribe
    - `/victim/candidate` (std_msgs/Empty) : 검사 후보 발생
    - `/victim/confirmed` (geometry_msgs/PoseStamped) : victim 확정
    - `/victim/rejected` (std_msgs/Empty) : 오탐 처리
    - `/goal_pose` (geometry_msgs/PoseStamped) : 검사 목표 입력
- Action Client
    - `/navigate_to_pose` (nav2_msgs/NavigateToPose) : Nav2 목표 주행
### people_status_sub.py (turtlebot_status_monitor)
- Subscribe
    - `/tb3_04/detected_person/relative_pos` (geometry_msgs/PointStamped) : 구호봇 확정 대상자 상대 좌표
