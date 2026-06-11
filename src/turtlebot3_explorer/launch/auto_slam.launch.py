#!/usr/bin/env python3
# =====================================================================
# auto_slam_launch.py  (단일 로봇 / 네임스페이스 없음 / 도메인 격리)
#
# 전제:
#   - 로봇 bringup 도 이 PC 도 ROS_DOMAIN_ID=41 로 실행 (실행 전 export)
#       로봇:  export ROS_DOMAIN_ID=41 && ros2 launch turtlebot3_bringup robot.launch.py
#              (namespace 인자 없음!)
#   - 네임스페이스 미사용 -> 토픽 /scan, /odom, /cmd_vel / 프레임 map, odom, base_*
#   - 분리는 도메인이 담당하므로 tb3_NN/* 접두어가 전혀 필요 없음
#     (그래서 base_scan 다리 같은 보정도 불필요)
#
# 기동 순서:
#   t=0s   slam_toolbox + RViz
#   t=12s  nav2 (navigation_launch)
#   t=30s  mission_coordinator
#
#   - RViz 끄려면:  ros2 launch turtlebot3_explorer auto_slam_launch.py rviz:=false
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


def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')
    use_rviz = LaunchConfiguration('rviz')

    pkg_share = FindPackageShare('turtlebot3_explorer')
    # plain(네임스페이스 없는) 설정 파일
    nav2_params = PathJoinSubstitution([pkg_share, 'config', 'nav2_params.yaml'])
    slam_params = PathJoinSubstitution([pkg_share, 'config', 'slam_params.yaml'])
    rviz_config = PathJoinSubstitution([pkg_share, 'config', 'robot_view.rviz'])

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

    # ---- RViz (t=0) : 미리 설정된 뷰 (fixed frame = map) ----
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

    # ---- 탐색 코디네이터 (t=30s) : 프레임은 plain ----
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
                    'base_frame': 'base_footprint',
                    'global_frame': 'map',
                    'finish_topic': '/mission/finish_now',
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
