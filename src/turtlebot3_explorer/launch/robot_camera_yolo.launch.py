#!/usr/bin/env python3
# =====================================================================
# robot_camera_yolo.launch.py   (로봇 라파이에서 실행)
#
# 카메라(v4l2_camera) + YOLO 추론(victim_detector) 을 한 번에 기동.
# 기본 bringup(robot.launch.py)은 별도 터미널에서 따로 실행한다.
#
#   export ROS_DOMAIN_ID=41
#   ros2 launch turtlebot3_explorer robot_camera_yolo.launch.py
#
# 인자:
#   video_device     : 웹캠 장치 (기본 /dev/video2, loopback). WebRTC 와 카메라를
#                      동시 사용하려고 ffmpeg 가 video0 → video2 복제하는 구조.
#   camera_info_url  : 보정 yaml 경로 (camera_calibration 결과). 없으면 위치추정 부정확.
#   conf_threshold   : YOLO 점수 임계 (기본 0.45)
#   * 해상도는 아래 image_size(정수 배열) 에서 직접 수정.
#
# 발행: /image_raw, /image_raw/compressed, /camera_info, /victim/detections
#   (map 좌표 변환·확정은 PC 의 victim_mapper 가 수행)
#
# 의존성(라파이):
#   apt : ros-$ROS_DISTRO-v4l2-camera, ros-$ROS_DISTRO-compressed-image-transport,
#         ros-$ROS_DISTRO-vision-msgs
#   pip : onnxruntime, opencv-python
#   + turtlebot3_explorer 빌드(모델은 data_files 로 share/.../models/best.onnx 설치)
# =====================================================================
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, TimerAction
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution, TextSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    video_device = LaunchConfiguration('video_device')
    camera_info_url = LaunchConfiguration('camera_info_url')
    conf_threshold = LaunchConfiguration('conf_threshold')

    pkg_share = FindPackageShare('turtlebot3_explorer')
    # 패키지에 설치된 모델 (setup.py data_files 로 models/*.onnx 설치 가정)
    model_path = PathJoinSubstitution([pkg_share, 'models', 'best.onnx'])
    # 보정 yaml 기본값: 패키지 config/webcam.yaml (git 공유, 계정 무관)
    default_cam_info = PathJoinSubstitution([pkg_share, 'config', 'webcam.yaml'])

    # ---- 카메라 (v4l2_camera, apt 패키지) ----
    camera = Node(
        package='v4l2_camera',
        executable='v4l2_camera_node',
        name='v4l2_camera',
        output='screen',
        parameters=[{
            'video_device': video_device,
            'image_size': [352, 288],            # 실제 카메라 해상도. webcam.yaml 도 이 해상도 기준.
            'camera_frame_id': 'camera_optical_frame',
            'camera_info_url': camera_info_url,
            # 카메라가 안 열리거나 느리면 포맷 지정: 'pixel_format': 'YUYV' 또는 'MJPG'
            #   (v4l2-ctl --list-formats 로 지원 포맷 확인)
        }],
    )

    # ---- YOLO 추론 (turtlebot3_explorer, 카메라보다 약간 늦게 시작) ----
    victim_detector = TimerAction(
        period=3.0,   # 카메라/토픽이 먼저 올라올 여유
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
                    'process_interval': 0.1,     # 최대 ~10Hz 추론
                }],
            ),
        ],
    )

    return LaunchDescription([
        DeclareLaunchArgument('video_device', default_value='/dev/video2'),
        DeclareLaunchArgument(
            'camera_info_url',
            default_value=[TextSubstitution(text='file://'), default_cam_info],
            description='보정 yaml 경로. 기본은 패키지 config/webcam.yaml'),
        DeclareLaunchArgument('conf_threshold', default_value='0.45'),
        camera,
        victim_detector,
    ])