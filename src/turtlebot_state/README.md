# 사용법
## 탐사용 터틀봇 통합 실행
```bash
ros2 launch turtlebot_state explorer.launch.py
```

## 구호용 터틀봇 통합 실행
```bash
ros2 launch turtlebot_state rescuer.launch.py
```

# launch 상세
## 공통 스택
- turtlebot3_bringup robot.launch.py
- turtlebot3_hardware hardware_bringup.launch.py
- turtlebot_state deploy_node
- central_parking_monitor reverse_line_follower

## 탐사용 터틀봇 launch
- 공통 스택
- turtlebot_state explorer_state_manger

## 구호용 터틀봇 launch
- 공통 스택
- turtlebot3_navigation2 navigation2.launch.py
- turtlebot_state rescuer_state_manger
