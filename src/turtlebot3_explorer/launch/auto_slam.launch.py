#!/usr/bin/env python3
# =====================================================================
# bringup_pc_tb3_01.launch.py  (단일 로봇 / 네임스페이스 없는 두뇌 + RViz)
#
# 기동 순서:
#   t=0s   slam_toolbox  + RViz (미리 설정된 뷰: 맵/라이다/TF/로봇모델/경로)
#   t=12s  nav2
#   t=30s  coordinator
#
#   - 두뇌 노드는 네임스페이스 없음 -> critic 에러 없음.
#   - 프레임/토픽은 파라미터 파일에서 전부 tb3_01/* 로 지정.
#   - RViz 끄려면:  ros2 launch ... bringup_pc_tb3_01.launch.py rviz:=false
# =====================================================================
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare

NS = 'tb3_01'   # 파일 이름 규칙용. 노드를 네임스페이스하지는 않는다.


def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')
    use_rviz = LaunchConfiguration('rviz')

    pkg_share = FindPackageShare('turtlebot3_explorer')
    nav2_params = PathJoinSubstitution([pkg_share, 'config', f'nav2_params_{NS}.yaml'])
    slam_params = PathJoinSubstitution([pkg_share, 'config', f'slam_params_{NS}.yaml'])
    rviz_config = PathJoinSubstitution([pkg_share, 'config', f'{NS}_view.rviz'])

    nav2_launch = PathJoinSubstitution([FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py'])
    slam_launch = PathJoinSubstitution([FindPackageShare('slam_toolbox'), 'launch', 'online_async_launch.py'])

    # ---- slam_toolbox (t=0) ----
    slam = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(slam_launch),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'slam_params_file': slam_params,
        }.items(),
    )

    # ---- RViz (t=0) : 미리 설정된 뷰 ----
    rviz = Node(
        package='rviz2',
        executable='rviz2',
        name='rviz2',
        arguments=['-d', rviz_config],
        parameters=[{'use_sim_time': ParameterValue(use_sim_time, value_type=bool)}],
        output='screen',
        condition=IfCondition(use_rviz),
    )

    # ---- nav2 (t=12s) ----
    nav2 = TimerAction(
        period=12.0,
        actions=[
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(nav2_launch),
                launch_arguments={
                    'use_sim_time': use_sim_time,
                    'params_file': nav2_params,
                }.items(),
            ),
        ],
    )

    # ---- 탐색 코디네이터 (t=30s) ----
    coordinator = TimerAction(
        period=30.0,
        actions=[
            Node(
                package='turtlebot3_explorer',
                executable='mission_coordinator',
                name='mission_coordinator',
                output='screen',
                parameters=[{
                    'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
                    'map_save_path': map_save_path,
                    'base_frame': 'tb3_01/base_footprint',
                    'global_frame': 'tb3_01/map',
                }],
            ),
        ],
    )

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument('map_save_path', default_value=os.path.expanduser('~/maps/disaster_map')),
        DeclareLaunchArgument('rviz', default_value='true'),
        slam,
        rviz,
        nav2,
        coordinator,
    ])
