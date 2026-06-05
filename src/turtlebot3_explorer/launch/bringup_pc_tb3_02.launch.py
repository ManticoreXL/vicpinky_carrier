#!/usr/bin/env python3
"""
vicpinky_carrier - bringup_pc_tb3_02.launch.py

실물 로봇(tb3_02, 도메인 분리됨)용 '두뇌' 런치 (PC 에서 실행).

[로봇 현실 - 확인된 사실]
  - 토픽 : /tb3_02/scan, /tb3_02/odom, /tb3_02/cmd_vel  (네임스페이스됨)
  - 프레임: tb3_02/map -> tb3_02/odom -> tb3_02/base_footprint  (접두어 붙음)
  - TF   : 글로벌 /tf 에 올라옴 (프레임 이름으로 로봇을 구분하는 공유-/tf 설계)

[설계 - 단일 두뇌(로봇 1대) 기준]
  두뇌 노드는 '네임스페이스 없이' 평범하게 실행한다(노드 이름이 yaml 키와 그대로 매칭 -> critic 에러 없음).
  대신:
    - 프레임 이름은 yaml 안에서 tb3_02/*  (nav2_params_tb3_02 / slam_params_tb3_02)
    - 입력/출력 토픽은 /tb3_02/scan, /tb3_02/odom, /tb3_02/cmd_vel
    - TF 는 글로벌 /tf 그대로 (로봇과 동일) -> 별도 처리 불필요
  slam 은 /map 토픽(frame_id=tb3_02/map)을 발행, nav2/coordinator 는 /map 그대로 구독.
  coordinator 는 /navigate_to_pose, /slam_toolbox/save_map 기본 이름 사용 -> remap 불필요,
  프레임만 tb3_02/* 로 파라미터 주입.

[멀티로봇으로 갈 때]
  두 번째 로봇 두뇌를 같은 PC/도메인에서 동시에 돌리려면 '노드 이름 충돌'을 막아야 하므로
  그때 두뇌를 네임스페이스화한다. 단 로봇이 글로벌 /tf 를 쓰므로 네임스페이스 두뇌의 tf 도
  글로벌 /tf 로 유지해야 한다(별도 작업). 지금은 tb3_02 단독으로 먼저 검증.

로봇(별도): tb3_02 네임스페이스 bringup (이미 /tb3_02/scan 등 발행 확인됨)

실행:
  ros2 launch vicpinky_carrier bringup_pc_tb3_02.launch.py
"""

import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare

NS = 'tb3_02'   # 프레임 접두어 (yaml 안의 프레임 이름과 일치해야 함)


def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')

    pkg_share = FindPackageShare('vicpinky_carrier')
    nav2_params = PathJoinSubstitution([pkg_share, 'config', 'nav2_params_tb3_02.yaml'])
    slam_params = PathJoinSubstitution([pkg_share, 'config', 'slam_params_tb3_02.yaml'])

    nav2_launch = PathJoinSubstitution(
        [FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py']
    )
    slam_launch = PathJoinSubstitution(
        [FindPackageShare('slam_toolbox'), 'launch', 'online_async_launch.py']
    )

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument(
            'map_save_path',
            default_value=os.path.expanduser('~/maps/disaster_map')),

        # 1) SLAM (네임스페이스 없음. 프레임/스캔은 slam_params_tb3_02 가 tb3_02/* 로 지정,
        #    /map 토픽을 frame_id=tb3_02/map 으로 발행, map->odom TF 는 글로벌 /tf 로)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(slam_launch),
            launch_arguments={
                'use_sim_time': use_sim_time,
                'slam_params_file': slam_params,
            }.items(),
        ),

        # 2) Nav2 (네임스페이스 없음. nav2_params_tb3_02: 프레임 tb3_02/*, 토픽 /tb3_02/*,
        #    cmd_vel 출력 /tb3_02/cmd_vel)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(nav2_launch),
            launch_arguments={
                'use_sim_time': use_sim_time,
                'params_file': nav2_params,
            }.items(),
        ),

        # 3) 코디네이터 (네임스페이스 없음. /map, /navigate_to_pose, /slam_toolbox/save_map
        #    기본 이름 그대로 -> remap 불필요. 프레임만 tb3_02/* 주입)
        TimerAction(
            period=20.0,
            actions=[
                Node(
                    package='vicpinky_carrier',
                    executable='mission_coordinator',
                    name='mission_coordinator',
                    output='screen',
                    parameters=[{
                        'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
                        'map_save_path': map_save_path,
                        'base_frame': f'{NS}/base_footprint',
                        'global_frame': f'{NS}/map',
                    }],
                ),
            ],
        ),
    ])
