#!/usr/bin/env python3
"""
vicpinky_carrier - bringup_pc.launch.py

PC(관제) 측에서 한 번에 띄우는 '두뇌' 런치.
  1) slam_toolbox      : 매핑(/map 발행, map->odom TF)
  2) Nav2              : navigate_to_pose 액션 서버
  3) mission_coordinator : 자율 탐색 지휘

※ 로봇 하드웨어 계층(실제 로봇의 turtlebot3_bringup, 또는 시뮬레이터)은
   여기 포함하지 않는다. 이 파일은 '두뇌'만 담당하며 시뮬/실로봇 양쪽에서 재사용된다.

  실제 로봇 : (로봇에서) turtlebot3_bringup 실행 + (PC에서) 이 파일을 use_sim_time:=false
  시뮬레이션: sim.launch.py 가 gazebo + 이 파일(use_sim_time:=true) 을 묶어서 실행
"""

import os

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    IncludeLaunchDescription,
    TimerAction,
)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')

    slam_launch = PathJoinSubstitution(
        [FindPackageShare('slam_toolbox'), 'launch', 'online_async_launch.py']
    )
    nav2_launch = PathJoinSubstitution(
        [FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py']
    )
    nav2_params = PathJoinSubstitution(
        [FindPackageShare('vicpinky_carrier'), 'config', 'nav2_params.yaml']
    )

    return LaunchDescription([
        DeclareLaunchArgument(
            'use_sim_time',
            default_value='true',
            description='시뮬레이션이면 true, 실제 로봇이면 false',
        ),
        DeclareLaunchArgument(
            'map_save_path',
            default_value=os.path.expanduser('~/maps/disaster_map'),
            description='미션 종료 시 저장할 맵 경로(확장자 제외, 절대경로 권장)',
        ),

        # 1) SLAM : 지도 작성 + map->odom TF
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(slam_launch),
            launch_arguments={'use_sim_time': use_sim_time}.items(),
        ),

        # 2) Nav2 : navigate_to_pose 제공 (map_server/amcl 없음 - 지도는 SLAM이 줌)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(nav2_launch),
            launch_arguments={
                'use_sim_time': use_sim_time,
                'params_file': nav2_params,      # ← 이 줄이 핵심
            }.items(),
        ),

        # 3) 코디네이터 : SLAM/Nav2 가 올라올 여유를 두고 8초 뒤 실행
        #    (노드 자체도 서버를 못 찾으면 재시도하지만, 로그를 깔끔하게 하려고 지연)
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
                    }],
                ),
            ],
        ),
    ])
