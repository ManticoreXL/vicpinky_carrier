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

    return LaunchDescription([
        headlight_node,
        voice_node
    ])