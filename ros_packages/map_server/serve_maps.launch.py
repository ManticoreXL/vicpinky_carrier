#!/usr/bin/env python3
"""
서버(도메인 49)에서 로봇별 nav2_map_server 를 띄워 정적 맵을 발행한다.

각 로봇(tb3_03/tb3_04 등)은 SLAM/map_server 없이 navigation 만 켜고,
도메인 브릿지가 /{robot}/map (49) → /map (로봇 도메인) 으로 latched 전달한다.
AMCL 초기값(initialpose)은 기존 /{robot}/initialpose 다운링크로 서버가 주입.

사용:  ROS_DOMAIN_ID=49 ros2 launch serve_maps.launch.py
       (또는 start_map_server.sh)

로봇마다 다른 맵을 주려면 아래 ROBOTS 의 yaml 경로만 바꾸면 된다.
"""
import os
from launch import LaunchDescription
from launch_ros.actions import Node

# 기본 맵 파일은 web_back/map 에 둔 것을 사용
MAP_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'web_back', 'map')
)

# (namespace=로봇id, map yaml=드롭다운 map_id 와 동일 이름, map frame_id)
#  frame_id 는 로봇 Nav2 의 global_frame 과 일치해야 한다(기본 'map').
#  로봇 TF 가 네임스페이스되어 있으면 'tb3_04/map' 등으로 바꾼다.
ROBOTS = [
    # tb3_04 할당 map_id = '401'. frame_id 는 로봇 nav2(amcl/costmap)와 동일해야 한다.
    # 표준 turtlebot3_navigation2 는 평문 프레임을 쓰므로 'map'.
    ('tb3_04', os.path.join(MAP_DIR, '401.yaml'), 'map'),
]


def generate_launch_description() -> LaunchDescription:
    nodes = []
    for ns, yaml_file, frame in ROBOTS:
        # 로봇별 map_server → /{ns}/map 발행 (latched, transient_local)
        nodes.append(Node(
            package='nav2_map_server',
            executable='map_server',
            name='map_server',
            namespace=ns,
            output='screen',
            parameters=[{
                'yaml_filename': os.path.abspath(yaml_file),
                'frame_id': frame,
                'topic_name': 'map',
            }],
        ))
        # 로딩 완료(configure→activate)까지 자동 진행 → 활성화되면 맵 발행 시작
        nodes.append(Node(
            package='nav2_lifecycle_manager',
            executable='lifecycle_manager',
            name='lifecycle_manager_map',
            namespace=ns,
            output='screen',
            parameters=[{
                'autostart': True,
                'node_names': ['map_server'],
            }],
        ))
    return LaunchDescription(nodes)
