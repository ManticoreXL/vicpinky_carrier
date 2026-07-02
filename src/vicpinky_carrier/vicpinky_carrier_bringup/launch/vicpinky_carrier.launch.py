import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (
    IncludeLaunchDescription, ExecuteProcess, RegisterEventHandler,
)
from launch.event_handlers import OnProcessExit
from launch.launch_description_sources import (
    AnyLaunchDescriptionSource, PythonLaunchDescriptionSource,
)
from launch_ros.actions import Node


def generate_launch_description():
    # 1. vicpinky_bringup 패키지의 XML 런치 포함
    vicpinky_bringup_dir = get_package_share_directory('vicpinky_bringup')
    bringup_launch_path = os.path.join(
        vicpinky_bringup_dir, 'launch', 'bringup.launch.xml'
    )
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

    # marker 카메라(/dev/video11)가 실제 1프레임을 낼 때까지 대기하는 프로브
    wait_for_marker_cam = ExecuteProcess(
        cmd=[
            'bash', '-c',
            'until timeout 2 ffmpeg -nostdin -loglevel error '
            '      -f v4l2 -i /dev/video11 -frames:v 1 -f null - >/dev/null 2>&1; '
            'do echo "waiting for /dev/video11 ..."; sleep 0.5; done; '
            'echo "/dev/video11 ready"'
        ],
        name='wait_for_marker_cam',
        output='screen',
    )

    # 프로브가 끝나면(= 카메라 준비 완료) marker_controller 시작
    start_marker = RegisterEventHandler(
        OnProcessExit(
            target_action=wait_for_marker_cam,
            on_exit=[marker_controller_node],
        )
    )

    # 5. 전체 묶기
    return LaunchDescription([
        include_bringup,
        include_webrtc,
        ramp_action_server_node,
        wait_for_marker_cam,
        start_marker,
    ])