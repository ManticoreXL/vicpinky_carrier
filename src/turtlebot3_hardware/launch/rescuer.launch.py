#!/usr/bin/env python3
#
# rescuer_bringup.launch.py
# 구호 터틀봇 한 대를 구동하는 데 필요한 노드를 한 번에 켠다.
#   1) 터틀봇 브링업 (모터/센서)
#   2) Nav2 (자율 주행) — turtlebot_state/map/disaster_map.yaml 사용
#   3) 로컬 중앙 상태 노드 (rescuer_state_manager)
#
# 실행 예:
#   ros2 launch turtlebot_state rescuer_bringup.launch.py bot_id:=tb3_04 marker_id:=4
#
# 주의:
#   - 미션 진행 신호(DEPLOY/GO_LOAD 등)는 여기 없다. 그건 PC가 보낸다.
#   - 라인트레이서/배달/주차 등 기능 노드는 아직 여기 안 넣었다.
#     (노드가 더 만들어지면 이 파일에 한 줄씩 추가)
#   - Nav2 launch 이름이 환경과 다르면 nav2_launch 부분을 수정.

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    IncludeLaunchDescription,
    TimerAction,
)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # ── 실행 인자 ──
    bot_id = LaunchConfiguration('bot_id')
    marker_id = LaunchConfiguration('marker_id')
    use_sim_time = LaunchConfiguration('use_sim_time')

    declare_bot_id = DeclareLaunchArgument(
        'bot_id', default_value='tb3_04',
        description='로봇 ID (로그/마커 매칭용)')
    declare_marker_id = DeclareLaunchArgument(
        'marker_id', default_value='4',
        description='주차 마커 번호')
    declare_use_sim_time = DeclareLaunchArgument(
        'use_sim_time', default_value='false',
        description='시뮬레이션이면 true')

    # ── 맵 파일 경로 (이 패키지 안에 설치된 맵) ──
    map_yaml = os.path.join(
        get_package_share_directory('turtlebot_state'),
        'map', 'disaster_map.yaml')

    # ── 1) 브링업 ──
    bringup_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(
            get_package_share_directory('turtlebot3_bringup'),
            'launch', 'robot.launch.py')),
        launch_arguments={'use_sim_time': use_sim_time}.items(),
    )

    # ── 2) Nav2 (브링업 후 잠시 뒤에 켜서 센서/TF 준비 시간 확보) ──
    nav2_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(
            get_package_share_directory('turtlebot3_navigation2'),
            'launch', 'navigation2.launch.py')),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'map': map_yaml,
        }.items(),
    )
    nav2_delayed = TimerAction(period=5.0, actions=[nav2_launch])

    # ── 3) 로컬 중앙 상태 노드 ──
    state_node = Node(
        package='turtlebot_state',
        executable='rescuer_state_manager',
        name='rescuer_state_manager',
        output='screen',
        parameters=[{
            'bot_id': bot_id,
            'marker_id': marker_id,
        }],
    )

    return LaunchDescription([
        declare_bot_id,
        declare_marker_id,
        declare_use_sim_time,
        bringup_launch,
        nav2_delayed,
        state_node,
    ])
