# turtlebot3_hardware/launch/robot_common.launch.py
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    default_bot_id = os.environ.get('BOT_ID', 'tb3_01')

    bot_id_arg = DeclareLaunchArgument(
        'bot_id', default_value=default_bot_id, description='ID of the robot')
    bot_id = LaunchConfiguration('bot_id')

    # 1. turtlebot3_bringup
    tb3_bringup = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_bringup'), '/launch/robot.launch.py'
        ])
    )

    # 2. turtlebot3_hardware bringup
    hw_bringup = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_hardware'), '/launch/hardware_bringup.launch.py'
        ]),
        launch_arguments={'bot_id': bot_id, 'device': '3'}.items()
    )

    # 3. DEPLOY 노드 (하차)
    deploy_node = Node(
        package='turtlebot_state', executable='deploy_node', name='deploy_node',
        output='screen', parameters=[{'bot_id': bot_id}]
    )

    # 4. TRACE 라인트레이서
    reverse_line_follower = Node(
        package='central_parking_monitor', executable='reverse_line_follower',
        name='reverse_line_follower', output='screen', parameters=[{'bot_id': bot_id}]
    )

    return LaunchDescription([
        bot_id_arg, tb3_bringup, hw_bringup, deploy_node, reverse_line_follower,
    ])