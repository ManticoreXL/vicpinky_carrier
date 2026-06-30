import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

def generate_launch_description():
    bot_id_arg = DeclareLaunchArgument(
        'bot_id',
        default_value='tb3_01',
        description='ID of the robot (e.g., tb3_01, tb3_02, vicpinky)'
    )

    device_arg = DeclareLaunchArgument(
        'device',
        default_value='2',
        description='Camera device number (e.g., 0, 1, 2, 3)'
    )

    headlight_node = Node(
        package='turtlebot3_hardware',
        executable='headlight_node',
        name='headlight_node',
        output='screen'
    )

    voice_node = Node(
        package='turtlebot3_hardware',
        executable='voice_node',
        name='voice_node',
        output='screen'
    )

    rosbridge_node = Node(
        package='rosbridge_server',
        executable='rosbridge_websocket',
        name='rosbridge_websocket',
        output='screen',
        parameters=[{'port': 9090}]
    )

    webrtc_node = Node(
        package='turtlebot3_hardware',
        executable='turtlebot3_webrtc',
        name='turtlebot3_webrtc',
        output='screen',
        arguments=[
            '--server', 'http://10.10.14.70:3001',
            '--bot-id', LaunchConfiguration('bot_id'),
            '--device', LaunchConfiguration('device')
        ]
    )

    return LaunchDescription([
        bot_id_arg, 
        device_arg,
        headlight_node,
        voice_node,
        rosbridge_node,
        webrtc_node
    ])
