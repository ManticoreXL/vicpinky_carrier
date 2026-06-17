#!/usr/bin/env python3

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

def generate_launch_description():
    # 💡 터미널에서 실행할 때 매핑 인자를 넘겨받을 수 있도록 선언
    parking_id_arg = DeclareLaunchArgument(
        'parking_id',
        default_value='12',
        description='Target parking spot marker ID (1~4)'
    )

    robot_id_arg = DeclareLaunchArgument(
        'robot_id',
        default_value='2',
        description='Target robot Aruco marker ID (11~14)'
    )

    # 📐 정밀 주차 도킹 튜닝 파라미터 (현장에서 값만 바꿔서 재실행 가능)
    kp_theta_arg = DeclareLaunchArgument(
        'kp_theta',
        default_value='0.4',
        description='헤딩 오차에 대한 P게인'
    )

    park_linear_speed_arg = DeclareLaunchArgument(
        'park_linear_speed',
        default_value='0.02',
        description='정밀 주차(STATE 2) 시 후진 속도(m/s)'
    )

    park_dist_threshold_px_arg = DeclareLaunchArgument(
        'park_dist_threshold_px',
        default_value='30.0',
        description='주차 완료로 판정할 로봇-주차면 마커 중심 간 거리(px)'
    )

    park_blend_dist_px_arg = DeclareLaunchArgument(
        'park_blend_dist_px',
        default_value='150.0',
        description='접근 방향 -> 최종 정렬 방향으로 목표 헤딩을 전환하기 시작하는 거리(px)'
    )

    max_angular_z_arg = DeclareLaunchArgument(
        'max_angular_z',
        default_value='0.5',
        description='정밀 주차 시 angular.z 최대값(rad/s)'
    )

    heading_offset_deg_arg = DeclareLaunchArgument(
        'heading_offset_deg',
        default_value='0.0',
        description='로봇 마커 헤딩과 주차면 마커 헤딩 간 부착 오프셋 보정값(deg)'
    )

    enable_gui_arg = DeclareLaunchArgument(
        'enable_gui',
        default_value='true',
        description='천장 카메라 모니터 창 표시 여부 (헤드리스 환경에서는 false)'
    )

    return LaunchDescription([
        # 런치 인자 등록
        parking_id_arg,
        robot_id_arg,
        kp_theta_arg,
        park_linear_speed_arg,
        park_dist_threshold_px_arg,
        park_blend_dist_px_arg,
        max_angular_z_arg,
        heading_offset_deg_arg,
        enable_gui_arg,

        # 1. 후진 라인트레이싱 노드 실행
        Node(
            package='central_parking_monitor',
            executable='reverse_line_follower',
            name='reverse_line_follower_node',
            output='screen',
            emulate_tty=True
        ),

        # 2. 중앙 관제형 정밀 주차 제어 노드 실행
        Node(
            package='central_parking_monitor',
            executable='parking_controller',
            name='central_parking_controller_jazzy',
            output='screen',
            emulate_tty=True,
            # 🌐 관제에 필요한 마커 ID 및 도킹 튜닝 파라미터 주입
            parameters=[{
                'parking_id': LaunchConfiguration('parking_id'),
                'robot_id': LaunchConfiguration('robot_id'),
                'kp_theta': LaunchConfiguration('kp_theta'),
                'park_linear_speed': LaunchConfiguration('park_linear_speed'),
                'park_dist_threshold_px': LaunchConfiguration('park_dist_threshold_px'),
                'park_blend_dist_px': LaunchConfiguration('park_blend_dist_px'),
                'max_angular_z': LaunchConfiguration('max_angular_z'),
                'heading_offset_deg': LaunchConfiguration('heading_offset_deg'),
                'enable_gui': LaunchConfiguration('enable_gui'),
            }]
        )
    ])