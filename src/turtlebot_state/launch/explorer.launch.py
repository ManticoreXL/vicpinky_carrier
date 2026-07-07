#!/usr/bin/env python3
# explorer_camera_yolo.launch.py (통합본)

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution, TextSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # ==========================================
    # 1. 실행 인자 (Arguments) 설정
    # ==========================================
    # 기존 explorer 인자
    default_bot_id = os.environ.get('BOT_ID', 'tb3_01')
    default_marker = os.environ.get('MARKER_ID', '11')

    bot_id_arg = DeclareLaunchArgument('bot_id', default_value=default_bot_id)
    marker_arg = DeclareLaunchArgument('marker_id', default_value=default_marker)

    # 카메라 및 YOLO 추가 인자
    #   video2 = loopback (ffmpeg 가 video0→video2 복제, WebRTC 와 동시사용 위함)
    video_device_arg = DeclareLaunchArgument('video_device', default_value='/dev/video2')
    #   camera_info: 패키지 config/webcam.yaml (계정 무관, git 공유). 없으면 camera_info=0 → 마커 NaN.
    default_cam_info = PathJoinSubstitution([
        FindPackageShare('turtlebot3_explorer'), 'config', 'webcam.yaml'])
    camera_info_url_arg = DeclareLaunchArgument(
        'camera_info_url',
        default_value=[TextSubstitution(text='file://'), default_cam_info]
    )
    conf_threshold_arg = DeclareLaunchArgument('conf_threshold', default_value='0.45')

    # LaunchConfiguration 매핑
    bot_id = LaunchConfiguration('bot_id')
    marker_id = LaunchConfiguration('marker_id')
    video_device = LaunchConfiguration('video_device')
    camera_info_url = LaunchConfiguration('camera_info_url')
    conf_threshold = LaunchConfiguration('conf_threshold')

    # ==========================================
    # 2. 로봇 공통 스택 및 상태 머신 (기존 explorer)
    # ==========================================
    # 공통 스택
    common = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([
            FindPackageShare('turtlebot3_hardware'), 
            '/launch/robot_common.launch.py'
        ]),
        launch_arguments={'bot_id': bot_id}.items()
    )

    # ==========================================
    # 3. 카메라 및 YOLO 노드 (추가 기능)
    # ==========================================
    model_path = PathJoinSubstitution([FindPackageShare('turtlebot3_explorer'), 'models', 'best.onnx'])

    # 카메라 노드
    camera_node = Node(
        package='v4l2_camera',
        executable='v4l2_camera_node',
        name='v4l2_camera',
        output='screen',
        parameters=[{
            'video_device': video_device,
            'image_size': [352, 288],
            'camera_frame_id': 'camera_optical_frame',
            'camera_info_url': camera_info_url,
        }],
    )

    # YOLO 추론 노드 (카메라가 켜진 후 3초 뒤 실행)
    victim_detector_node = TimerAction(
        period=3.0,
        actions=[
            Node(
                package='turtlebot3_explorer',
                executable='victim_detector',
                name='victim_detector',
                output='screen',
                parameters=[{
                    'model_path': ParameterValue(model_path, value_type=str),
                    'image_topic': '/image_raw/compressed',
                    'detections_topic': '/victim/detections',
                    'camera_frame': 'camera_optical_frame',
                    'input_size': 320,
                    'conf_threshold': ParameterValue(conf_threshold, value_type=float),
                    'nms_iou': 0.5,
                    'process_interval': 0.1,
                    # 확정 스냅샷(확정 시 jpg 저장 + /victim/snapshot 발행)
                    'enable_snapshot': True,
                    'confirmed_topic': '/victim/confirmed',
                    'snapshot_topic': '/victim/snapshot',
                    'publish_snapshot': True,
                    'snapshot_jpeg_quality': 80,
                    # 진단 로그(카메라 프레임/추론결과). 평소엔 False 로 꺼도 됨.
                    'debug_log': True,
                }],
            ),
        ],
    )

    state_node = Node(
        package='turtlebot_state', 
        executable='robot_state_manager',
        name='robot_state_manager', 
        output='screen',
        parameters=[{
            'bot_id': bot_id,
            'marker_id': ParameterValue(marker_id, value_type=int),
        }]
    )

    # ==========================================
    # 4. 최종 런치 디스크립션 반환
    # ==========================================
    return LaunchDescription([
        # 인자 선언부
        bot_id_arg, 
        marker_arg, 
        video_device_arg,
        camera_info_url_arg,
        conf_threshold_arg,

        # 노드 및 실행부
        common, 
        state_node,
        camera_node,
        victim_detector_node
    ])