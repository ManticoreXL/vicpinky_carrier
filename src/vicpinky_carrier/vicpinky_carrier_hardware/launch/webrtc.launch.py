import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument, ExecuteProcess, RegisterEventHandler,
)
from launch.event_handlers import OnProcessExit
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # ── 공통 인자 ──────────────────────────────────────────────
    server_arg = DeclareLaunchArgument(
        'server',
        default_value='http://10.10.14.70:3001',
        description='NestJS 시그널링 서버 URL'
    )
    front_bot_id_arg = DeclareLaunchArgument(
        'front_bot_id',
        default_value='vicpinky_cam0',
        description='전방 주행 카메라 봇 ID'
    )
    internal_bot_id_arg = DeclareLaunchArgument(
        'internal_bot_id',
        default_value='vicpinky_cam1',
        description='내부 카메라 봇 ID'
    )
    front_device_arg = DeclareLaunchArgument(
        'front_device', default_value='0', description='전방 카메라 장치 번호'
    )
    internal_device_arg = DeclareLaunchArgument(
        'internal_device', default_value='10', description='내부 카메라 loopback 장치 번호'
    )

    # ── ffmpeg 분할 인자 ───────────────────────────────────────
    source_device_arg = DeclareLaunchArgument(
        'source_device', default_value='/dev/video6',
        description='분할할 원본 카메라 (RealSense 컬러)'
    )
    loopback_a_arg = DeclareLaunchArgument(
        'loopback_a', default_value='/dev/video10',
        description='webrtc용 loopback'
    )
    loopback_b_arg = DeclareLaunchArgument(
        'loopback_b', default_value='/dev/video11',
        description='marker용 loopback'
    )
    startup_delay_arg = DeclareLaunchArgument(
        'startup_delay', default_value='4.0',
        description='ffmpeg가 loopback을 채울 때까지 webrtc 노드 시작 지연(초)'
    )

    # ── ffmpeg: /dev/video6 → video10 + video11 분할 ───────────
    # 원본이 RealSense 컬러(YUYV 640x480 30fps)라 input_format을 yuyv422로 고정.
    # 두 loopback 모두 yuv420p(rawvideo)로 내보내 OpenCV/브라우저 호환.
    camera_split = ExecuteProcess(
        cmd=[
            'ffmpeg', '-nostdin', '-loglevel', 'warning',
            '-f', 'v4l2', '-input_format', 'yuyv422',
            '-video_size', '640x480', '-framerate', '30',
            '-i', LaunchConfiguration('source_device'),
            '-filter_complex', '[0:v]format=yuv420p,split=2[a][b]',
            '-map', '[a]', '-vcodec', 'rawvideo', '-pix_fmt', 'yuv420p',
            '-f', 'v4l2', LaunchConfiguration('loopback_a'),
            '-map', '[b]', '-vcodec', 'rawvideo', '-pix_fmt', 'yuv420p',
            '-f', 'v4l2', LaunchConfiguration('loopback_b'),
        ],
        name='camera_split',
        output='screen',
        respawn=True,          # ffmpeg가 죽으면 자동 재시작
        respawn_delay=3.0,
    )

    # video10 / video11 이 실제로 1프레임을 낼 때까지 대기하는 프로브
    wait_for_loopback = ExecuteProcess(
        cmd=[
            'bash', '-c',
            'for d in /dev/video10 /dev/video11; do '
            '  until timeout 2 ffmpeg -nostdin -loglevel error '
            '        -f v4l2 -i "$d" -frames:v 1 -f null - >/dev/null 2>&1; do '
            '    echo "waiting for $d ..."; sleep 0.5; '
            '  done; echo "$d ready"; '
            'done'
        ],
        name='wait_for_loopback',
        output='screen',
    )

    # ── 스트림 1: 전방 주행 카메라 (/dev/video0) ────────────────
    webrtc_front = Node(
        package='vicpinky_carrier_hardware',
        executable='vicpinky_webrtc',
        name='webrtc_front',
        output='screen',
        arguments=[
            '--server',  LaunchConfiguration('server'),
            '--bot-id',  LaunchConfiguration('front_bot_id'),
            '--device',  LaunchConfiguration('front_device'),
        ],
    )

    # ── 스트림 2: 내부 카메라 loopback (/dev/video10) ──────────
    webrtc_internal = Node(
        package='vicpinky_carrier_hardware',
        executable='vicpinky_webrtc',
        name='webrtc_internal',
        output='screen',
        arguments=[
            '--server',  LaunchConfiguration('server'),
            '--bot-id',  LaunchConfiguration('internal_bot_id'),
            '--device',  LaunchConfiguration('internal_device'),
        ],
    )

    # ── webrtc 노드는 ffmpeg가 loopback을 채운 뒤 시작 ─────────
    start_webrtc = RegisterEventHandler(
        OnProcessExit(
            target_action=wait_for_loopback,
            on_exit=[webrtc_front, webrtc_internal],
        )
    )

    return LaunchDescription([
        server_arg,
        front_bot_id_arg,
        internal_bot_id_arg,
        front_device_arg,
        internal_device_arg,
        source_device_arg,
        loopback_a_arg,
        loopback_b_arg,
        startup_delay_arg,
        camera_split,
        wait_for_loopback,
        start_webrtc,
    ])