import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare

def generate_launch_description():
    # 운영체제 환경 변수에서 BOT_ID 값을 읽어옴
    # 없을 경우 'tb3_01'을 기본값으로 사용
    default_bot_id = os.environ.get('BOT_ID', 'tb3_01')

    # 읽어온 환경 변수를 런치 인자의 기본값으로 삽입
    bot_id_arg = DeclareLaunchArgument(
        'bot_id',
        default_value=default_bot_id,
        description='ID of the robot'
    )
    bot_id = LaunchConfiguration('bot_id')

    # 1. turtlebot3_bringup
    tb3_bringup = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_bringup'), '/launch/robot.launch.py'
        ])
    )

    # 2. turtlebot3_hardware
    hw_bringup = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_hardware'), '/launch/hardware_bringup.launch.py'
        ]),
        launch_arguments={
            'bot_id': bot_id,
            'device': '3'  # 가상 카메라 3번 고정 할당
        }.items()
    )

    # 3. turtlebot_people_tracker
    people_detector_node = Node(
        package='turtlebot_people_tracker',
        executable='people_detector',
        name='people_detector',
        output='screen',
        parameters=[{
            'bot_id': bot_id,
            'device': 2  # 가상 카메라 2번 고정 할당
        }]
    )

    # 4. central_parking_monitor
    reverse_line_follower_node = Node(
        package='central_parking_monitor',
        executable='reverse_line_follower',
        name='reverse_line_follower',
        output='screen',
        parameters=[{
            'bot_id': bot_id
        }]
    )

    return LaunchDescription([
        bot_id_arg,
        tb3_bringup,
        hw_bringup,
        people_detector_node,
        reverse_line_follower_node
    ])