#!/usr/bin/env python3
# rescuer_bringup.launch.py

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
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # 실행 인자
    default_bot_id = os.environ.get('BOT_ID', 'tb3_01')
    default_marker = os.environ.get('MARKER_ID', '11')

    bot_id_arg = DeclareLaunchArgument('bot_id', default_value=default_bot_id)
    marker_arg = DeclareLaunchArgument('marker_id', default_value=default_marker)
    use_sim_time_arg = DeclareLaunchArgument('use_sim_time', default_value='false')

    bot_id = LaunchConfiguration('bot_id')
    marker_id = LaunchConfiguration('marker_id')
    use_sim_time = LaunchConfiguration('use_sim_time')

    # 맵 파일 경로 (이 패키지 안에 설치된 맵)
    map_yaml = os.path.join(
        get_package_share_directory('turtlebot_state'),
        'map', 
        'disaster_map.yaml'
    )

    # 공통 스택
    common = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_hardware'), 
            '/launch/robot_common.launch.py'
        ]),
        launch_arguments={'bot_id': bot_id}.items()
    )

    state_node = Node(
        package='turtlebot_state', 
        executable='robot_state_manager',
        name='robot_state_manager', 
        output='screen',
        parameters=[{
            'bot_id': bot_id,
            'marker_id': ParameterValue(marker_id, value_type=int),
        }]
    )

    # Nav2
    nav2_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(
            get_package_share_directory('turtlebot3_navigation2'),
            'launch', 'navigation2.launch.py')),
        launch_arguments={
            'use_sim_time': use_sim_time,
            # 'map': map_yaml,
        }.items(),
    )
    nav2_delayed = TimerAction(period=5.0, actions=[nav2_launch])

    return LaunchDescription([
        bot_id_arg,
        marker_arg,
        use_sim_time_arg,
        common,
        nav2_delayed,
        state_node,
    ])