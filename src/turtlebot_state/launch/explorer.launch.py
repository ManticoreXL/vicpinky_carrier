# turtlebot3_hardware/launch/explorer.launch.py
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    default_bot_id = os.environ.get('BOT_ID', 'tb3_01')
    default_marker = os.environ.get('MARKER_ID', '1')

    bot_id_arg = DeclareLaunchArgument('bot_id', default_value=default_bot_id)
    marker_arg = DeclareLaunchArgument('marker_id', default_value=default_marker)
    bot_id = LaunchConfiguration('bot_id')
    marker_id = LaunchConfiguration('marker_id')

    # 공통 스택
    common = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_hardware'), '/launch/robot_common.launch.py'
        ]),
        launch_arguments={'bot_id': bot_id}.items()
    )

    # 탐사봇 로컬 상태 노드
    state_mgr = Node(
        package='turtlebot_state', executable='explorer_state_manager',
        name='explorer_state_manager', output='screen',
        parameters=[{
            'bot_id': bot_id,
            'marker_id': ParameterValue(marker_id, value_type=int),
        }]
    )

    return LaunchDescription([bot_id_arg, marker_arg, common, state_mgr])