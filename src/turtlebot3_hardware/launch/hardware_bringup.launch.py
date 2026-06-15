import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
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
        executable='rosbridge_websocker',
        name='rosbridge_websocker',
        output='screen',
        parameters=[{'port': 9090}]
    )

    webrtc_node = Node(
        package='turtlebot3_hardware',
        executable='turtlebot3_webrtc',
        name='turtlebot3_webrtc',
        output='screen',
        arguments=['--server', 'http://10.10.14.70:3001']
    )

    return LaunchDescription([
        headlight_node,
        voice_node,
        rosbridge_node,
        webrtc_node
    ])
