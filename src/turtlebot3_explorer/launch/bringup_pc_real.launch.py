import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction, GroupAction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node, PushRosNamespace
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare

def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')
    robot_namespace = LaunchConfiguration('namespace')

    pkg_share = FindPackageShare('vicpinky_carrier')
    # 이전에 만드신 tb3_02 적용 파라미터 파일 사용
    nav2_params = PathJoinSubstitution([pkg_share, 'config', 'nav2_params_tb3_02.yaml'])
    slam_params = PathJoinSubstitution([pkg_share, 'config', 'slam_params_tb3_02.yaml'])

    nav2_launch = PathJoinSubstitution([FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py'])
    slam_launch = PathJoinSubstitution([FindPackageShare('slam_toolbox'), 'launch', 'online_async_launch.py'])

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument('map_save_path', default_value=os.path.expanduser('~/maps/disaster_map')),
        DeclareLaunchArgument('namespace', default_value='tb3_02'),

        GroupAction(
            actions=[
                PushRosNamespace(robot_namespace),
                
                # === ✨ 마법의 다리 (Static TF Bridge) ✨ ===
                # 로봇이 보낸 짧은 뼈대를, PC가 요구하는 긴 뼈대(tb3_02)로 강제 연결
                Node(
                    package='tf2_ros',
                    executable='static_transform_publisher',
                    name='base_footprint_bridge',
                    arguments=['0', '0', '0', '0', '0', '0', 'tb3_02/base_foot', 'tb3_02/base_footprint']
                ),

                IncludeLaunchDescription(
                    PythonLaunchDescriptionSource(slam_launch),
                    launch_arguments={'use_sim_time': use_sim_time, 'slam_params_file': slam_params}.items(),
                ),
                IncludeLaunchDescription(
                    PythonLaunchDescriptionSource(nav2_launch),
                    launch_arguments={'use_sim_time': use_sim_time, 'params_file': nav2_params, 'namespace': robot_namespace}.items(),
                ),
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
                                'base_frame': 'tb3_02/base_footprint', 
                                'global_frame': 'tb3_02/map',
                            }],
                        ),
                    ],
                ),
            ]
        )
    ])