import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import AnyLaunchDescriptionSource, PythonLaunchDescriptionSource
from launch_ros.actions import Node


def generate_launch_description():
    # 1. vicpinky_bringup 패키지의 XML 런치 포함
    vicpinky_bringup_dir = get_package_share_directory('vicpinky_bringup')
    bringup_launch_path = os.path.join(vicpinky_bringup_dir, 'launch', 'bringup.launch.xml')

    include_bringup = IncludeLaunchDescription(
        AnyLaunchDescriptionSource(bringup_launch_path)
    )

    # 2. webrtc 런치 포함 (ffmpeg 분할 + 카메라 2개로 가상화)
    hardware_dir = get_package_share_directory('vicpinky_carrier_hardware')
    webrtc_launch_path = os.path.join(hardware_dir, 'launch', 'webrtc.launch.py')

    include_webrtc = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(webrtc_launch_path)
    )

    # 3. ramp action server 노드
    ramp_action_server_node = Node(
        package='vicpinky_carrier_hardware',
        executable='ramp_action_server',
        name='ramp_action_server',
        output='screen',
    )

    # 4. marker_controller (marker_trace 액션 서버, video11 사용)
    marker_controller_node = Node(
        package='vicpinky_carrier_hardware',
        executable='marker_controller',
        name='central_parking_only',
        output='screen',
        parameters=[{'camera_index': 11}],
    )

    delayed_marker_controller = TimerAction(
        period=5.0,   # webrtc 런치의 startup_delay(4초)보다 약간 뒤
        actions=[marker_controller_node],
    )

    # 5. 전체 묶기
    return LaunchDescription([
        include_bringup,
        include_webrtc,
        ramp_action_server_node,
        delayed_marker_controller,
    ])