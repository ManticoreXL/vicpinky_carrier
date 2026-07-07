#!/usr/bin/env python3
# =====================================================================
# auto_slam_launch.py  (단일 로봇 / 네임스페이스 없음 / 도메인 격리)
#
# 전제:
#   - 로봇 bringup 도 이 PC 도 ROS_DOMAIN_ID=41 로 실행 (실행 전 export)
#       로봇:  export ROS_DOMAIN_ID=41 && ros2 launch turtlebot3_bringup robot.launch.py
#              (namespace 인자 없음!)
#       로봇:  + 카메라 퍼블리셔도 로봇에서!  (아래 '카메라' 참고)            ### [추가]
#   - 네임스페이스 미사용 -> 토픽 /scan, /odom, /cmd_vel / 프레임 map, odom, base_*
#   - 분리는 도메인이 담당하므로 tb3_NN/* 접두어가 전혀 필요 없음
#
# 기동 순서(PC):
#   t=0s   카메라 TF(static) + slam_toolbox + RViz + victim_mapper        ### [변경]
#   t=12s  nav2 (navigation_launch)
#   t=30s  mission_coordinator
#
#   - RViz 끄려면:  ros2 launch turtlebot3_explorer auto_slam_launch.py rviz:=false
#
# 카메라 + YOLO 추론 (로봇 라파이에서 각각 따로 실행 — PC 아님! 기본 bringup 과 별개):   ### [변경]
#   1) 카메라:
#      ros2 run v4l2_camera v4l2_camera_node --ros-args \
#        -p image_size:="[640,480]" \
#        -p camera_frame_id:=camera_optical_frame \
#        -p camera_info_url:=file:///home/ubuntu/.ros/camera_info/webcam.yaml
#      -> /image_raw/compressed, /camera_info 를 도메인 41 로 발행.
#   2) 추론 노드(라파이에서 YOLO):
#      ros2 run turtlebot3_explorer victim_detector --ros-args -p model_path:=~/models/best.onnx
#      -> /victim/detections (bbox) 발행. (map 좌표 변환·확정은 PC 의 victim_mapper 가 수행)
#   * camera_info_url 은 camera_calibration 으로 만든 보정 yaml (없으면 위치추정 부정확).
#
# 카메라 TF:
#   체인:  base_footprint -> camera_link -> camera_optical_frame
#   측정값(바닥=바퀴 닿는 면 기준): x=0.08m(전방), y=0.0, z=0.12m(바닥~렌즈), 수평 장착.
#   검증:  ros2 run tf2_ros tf2_echo base_footprint camera_optical_frame  (z≈0.12)
#   정확도 아쉬우면 cam_mount 의 --pitch 만 키워 카메라를 아래로(광학 회전은 변경 금지).
# =====================================================================
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    use_sim_time = LaunchConfiguration('use_sim_time')
    map_save_path = LaunchConfiguration('map_save_path')
    use_rviz = LaunchConfiguration('rviz')
    obstacle_radius = LaunchConfiguration('obstacle_radius')
    rear_depth = LaunchConfiguration('rear_depth')
    rear_width = LaunchConfiguration('rear_width')
    rear_left = LaunchConfiguration('rear_left')
    rear_right = LaunchConfiguration('rear_right')

    pkg_share = FindPackageShare('turtlebot3_explorer')
    # plain(네임스페이스 없는) 설정 파일
    nav2_params = PathJoinSubstitution([pkg_share, 'config', 'nav2_params.yaml'])
    slam_params = PathJoinSubstitution([pkg_share, 'config', 'slam_params.yaml'])
    rviz_config = PathJoinSubstitution([pkg_share, 'config', 'robot_view.rviz'])

    nav2_launch = PathJoinSubstitution([FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py'])
    slam_launch = PathJoinSubstitution([FindPackageShare('slam_toolbox'), 'launch', 'online_async_launch.py'])

    # ---- 카메라 TF (t=0) : base_footprint -> camera_link -> camera_optical_frame ----
    # 1) 물리 장착: 측정값(바닥 기준). 수평 장착이라 회전은 전부 0.
    cam_mount = Node(
        package='tf2_ros',
        executable='static_transform_publisher',
        name='base_to_cam',
        arguments=['--x', '0.08', '--y', '0.0', '--z', '0.12',
                   '--roll', '0', '--pitch', '0', '--yaw', '0',
                   '--frame-id', 'base_footprint', '--child-frame-id', 'camera_link'],
        parameters=[{'use_sim_time': ParameterValue(use_sim_time, value_type=bool)}],
        output='screen',
    )
    # 2) 광학 회전: 바디(x전방)->광학(z전방). 고정값이므로 변경 금지.
    cam_optical = Node(
        package='tf2_ros',
        executable='static_transform_publisher',
        name='cam_to_optical',
        arguments=['--x', '0', '--y', '0', '--z', '0',
                   '--roll', '-1.5708', '--pitch', '0', '--yaw', '-1.5708',
                   '--frame-id', 'camera_link', '--child-frame-id', 'camera_optical_frame'],
        parameters=[{'use_sim_time': ParameterValue(use_sim_time, value_type=bool)}],
        output='screen',
    )

    # ---- victim_mapper (t=0) : 라파이 bbox + camera_info + TF → 바닥 투영/확정/마커/CSV ----  ### [변경]
    #   (YOLO 추론은 라파이의 victim_detector 가 따로 수행 → /victim/detections 로 수신)
    victim_mapper = Node(
        package='turtlebot3_explorer',
        executable='victim_mapper',
        name='victim_mapper',
        output='screen',
        parameters=[{
            'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
            'detections_topic': '/victim/detections',
            'camera_info_topic': '/camera_info',
            'camera_frame': 'camera_optical_frame',
            'map_frame': 'map',
            'csv_path': os.path.expanduser('~/maps/victims.csv'),
        }],
    )

    # ---- victim_obstacle_publisher (t=0) : 확정 victim 을 costmap 장애물로 발행 ----
    #   /victim/list → /victim/obstacles(PointCloud2). nav2 가 victim 을 우회.
    #   (실시간/데모 공용 노드. 회피 로직은 여기 한 곳에만 둔다.)
    victim_obstacle = Node(
        package='turtlebot3_explorer',
        executable='victim_obstacle_publisher',
        name='victim_obstacle_publisher',
        output='screen',
        parameters=[{
            'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
            'obstacle_topic': '/victim/obstacles',
            'map_frame': 'map',
            'obstacle_radius': ParameterValue(obstacle_radius, value_type=float),
        }],
    )

    # ---- scan_normalizer (t=0) : LDS-02 스캔 포인트 수 변동 → slam_toolbox 드롭 방지 ----
    #   /scan 을 고정 각도 격자로 리샘플하여 /scan_normalized 로 발행.
    #   slam_params.yaml 의 scan_topic 이 /scan_normalized 를 보도록 되어 있어야 함.
    scan_normalizer = Node(
        package='turtlebot3_explorer',
        executable='scan_normalizer',
        name='scan_normalizer',
        output='screen',
        parameters=[{
            'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
            'input_topic': '/scan',
            'output_topic': '/scan_normalized',
            'num_beams': 0,   # 0 = 첫 스캔 개수로 자동 고정
        }],
    )

    # ---- slam_toolbox (t=0) ----
    slam = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(slam_launch),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'slam_params_file': slam_params,
        }.items(),
    )

    # ---- RViz (t=0) : 미리 설정된 뷰 (fixed frame = map) ----
    rviz = Node(
        package='rviz2',
        executable='rviz2',
        name='rviz2',
        arguments=['-d', rviz_config],
        parameters=[{'use_sim_time': ParameterValue(use_sim_time, value_type=bool)}],
        output='screen',
        condition=IfCondition(use_rviz),
    )

    # ---- nav2 (t=12s) ----
    nav2 = TimerAction(
        period=12.0,
        actions=[
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(nav2_launch),
                launch_arguments={
                    'use_sim_time': use_sim_time,
                    'params_file': nav2_params,
                }.items(),
            ),
        ],
    )

    # ---- 탐색 코디네이터 (t=30s) : 프레임은 plain ----
    coordinator = TimerAction(
        period=30.0,
        actions=[
            Node(
                package='turtlebot3_explorer',
                executable='mission_coordinator',
                name='mission_coordinator',
                output='screen',
                parameters=[{
                    'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
                    'map_save_path': map_save_path,
                    'base_frame': 'base_footprint',
                    'global_frame': 'map',
                    'finish_topic': '/mission/finish_now',
                    'rear_depth': ParameterValue(rear_depth, value_type=float),
                    'rear_width': ParameterValue(rear_width, value_type=float),
                    'rear_left': ParameterValue(rear_left, value_type=float),
                    'rear_right': ParameterValue(rear_right, value_type=float),
                }],
            ),
        ],
    )

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument('map_save_path', default_value=os.path.expanduser('~/maps/disaster_map')),
        DeclareLaunchArgument('rviz', default_value='true'),
        DeclareLaunchArgument(
            'obstacle_radius', default_value='0.5',
            description='victim 회피 장애물 반경(m). 좁은 공간이면 0.4, 넓으면 0.7로. '
                        '실제 회피거리는 이 값 + robot_radius + nav2 inflation 이 더해짐.'),
        DeclareLaunchArgument(
            'rear_depth', default_value='2.0',
            description='출발선 뒤 금지박스 깊이(m). 모선이 뒤로 차지하는 길이만큼. 측정 후 조정.'),
        DeclareLaunchArgument(
            'rear_width', default_value='1.5',
            description='출발선 뒤 금지박스 폭(m). 좌우 대칭용. rear_left/right 안 주면 이 값 절반씩.'),
        DeclareLaunchArgument(
            'rear_left', default_value='-1.0',
            description='금지박스를 왼쪽으로 막을 거리(m). 음수면 미지정(rear_width 절반 사용). '
                        '비대칭으로 한쪽만 넓힐 때 사용.'),
        DeclareLaunchArgument(
            'rear_right', default_value='-1.0',
            description='금지박스를 오른쪽으로 막을 거리(m). 음수면 미지정(rear_width 절반 사용).'),
        cam_mount,         ### [추가]
        cam_optical,       ### [추가]
        victim_mapper,     ### [변경] (PC: 투영/확정/마커/CSV)
        victim_obstacle,   ### [추가] (victim 회피 장애물 발행)
        scan_normalizer,   ### [추가] (스캔 정규화 → slam 드롭 방지)
        slam,
        rviz,
        nav2,
        coordinator,
    ])