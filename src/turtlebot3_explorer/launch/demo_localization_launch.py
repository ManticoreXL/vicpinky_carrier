#!/usr/bin/env python3
# =====================================================================
# demo_localization_launch.py  (데모 모드 / 단일 로봇 / 도메인 격리)
#
# 목적:
#   실시간 SLAM 대신 '미리 저장한 맵' 위에서 AMCL 로 위치추정하며 nav2 로
#   자율주행하고, 그 위에서 victim_detector(로봇) + victim_mapper(PC) 가
#   사람을 인식해 위치를 찍는 데모용 구성.
#   - auto_slam.launch.py 와 달리 slam_toolbox / mission_coordinator 는 안 띄움.
#   - 서버가 /goal_pose (또는 nav2 액션)로 목표를 주면 nav2 가 주행.
#
# 전제(로봇 라파이는 평소와 동일):
#   로봇:  ros2 launch turtlebot3_bringup robot.launch.py
#   로봇:  ros2 launch turtlebot3_explorer robot_camera_yolo.launch.py
#          -> /scan, /odom, TF(odom->base), /image_raw/compressed,
#             /camera_info, /victim/detections 발행 (도메인 43)
#
# 기동 순서(PC):
#   t=0s   카메라 static TF + victim_mapper + map_server/amcl(localization) + RViz
#   t=8s   nav2 (navigation_launch)
#
# 맵 파일:
#   teleop 으로 맵을 딴 뒤 map_saver 로 저장한 <이름>.yaml / <이름>.pgm 사용.
#   기본값: ~/maps/demo_map.yaml  (map 인자로 바꿀 수 있음)
#       ros2 launch turtlebot3_explorer demo_localization_launch.py \
#            map:=/home/userkk/maps/demo_map.yaml
#
# 초기 위치(중요):
#   AMCL 은 초기 추정 위치가 있어야 map->odom 을 만들어요. 두 가지 방법:
#   (1) nav2_params.yaml 의 amcl 에 아래를 넣으면 시작 시 자동 지정(추천):
#         amcl:
#           ros__parameters:
#             set_initial_pose: true
#             initial_pose: {x: 0.0, y: 0.0, z: 0.0, yaw: 0.0}
#       로봇을 맵의 그 좌표(보통 원점)에 두고 시작하면 끝.
#   (2) 또는 RViz 의 "2D Pose Estimate" 로 시작 때 한 번 찍기.
#   * 시작점이 원점이 아니면 (1)의 initial_pose 값을 실제 시작 좌표로 바꾸세요.
#
#   RViz 끄기:  ... demo_localization_launch.py rviz:=false
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
    use_rviz = LaunchConfiguration('rviz')
    map_yaml = LaunchConfiguration('map')

    pkg_share = FindPackageShare('turtlebot3_explorer')
    nav2_params = PathJoinSubstitution([pkg_share, 'config', 'nav2_params.yaml'])
    rviz_config = PathJoinSubstitution([pkg_share, 'config', 'robot_view.rviz'])

    nav2_launch = PathJoinSubstitution(
        [FindPackageShare('nav2_bringup'), 'launch', 'navigation_launch.py'])
    localization_launch = PathJoinSubstitution(
        [FindPackageShare('nav2_bringup'), 'launch', 'localization_launch.py'])

    # ---- 카메라 TF (t=0) : base_footprint -> camera_link -> camera_optical_frame ----
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

    # ---- victim_mapper (t=0) : bbox + camera_info + TF → 바닥 투영/확정/마커/CSV/report ----
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

    # ---- victim_inspector (t=0) : 응시 정지/재개 (회피는 obstacle_publisher 담당) ----
    #   /victim/candidate 수신 시 nav2 목표 취소·정지, confirmed/rejected 시 재전송.
    #   ※ 서버는 목표를 /goal_pose 로 보내야 이 노드가 기억·재전송할 수 있음.
    victim_inspector = Node(
        package='turtlebot3_explorer',
        executable='victim_inspector',
        name='victim_inspector',
        output='screen',
        parameters=[{
            'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
            'goal_in_topic': '/goal_pose',
            'map_frame': 'map',
            'inspect_timeout': 10.0,
        }],
    )

    # ---- victim_obstacle_publisher (t=0) : 확정 victim 을 costmap 장애물로 발행 ----
    #   /victim/list → /victim/obstacles(PointCloud2). nav2 가 우회 경로 생성.
    victim_obstacle = Node(
        package='turtlebot3_explorer',
        executable='victim_obstacle_publisher',
        name='victim_obstacle_publisher',
        output='screen',
        parameters=[{
            'use_sim_time': ParameterValue(use_sim_time, value_type=bool),
            'obstacle_topic': '/victim/obstacles',
            'map_frame': 'map',
            'obstacle_radius': 0.30,
        }],
    )

    # ---- localization (t=0) : map_server + amcl + lifecycle_manager ----
    #   저장된 맵을 /map 으로 발행하고, AMCL 이 map->odom TF 를 만들어 줌.
    #   set_initial_pose + initial_pose 로 시작 시 자동으로 초기위치 지정.
    localization = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(localization_launch),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'map': map_yaml,
            'params_file': nav2_params,
        }.items(),
    )

    # ---- RViz (t=0) ----
    rviz = Node(
        package='rviz2',
        executable='rviz2',
        name='rviz2',
        arguments=['-d', rviz_config],
        parameters=[{'use_sim_time': ParameterValue(use_sim_time, value_type=bool)}],
        output='screen',
        condition=IfCondition(use_rviz),
    )

    # ---- nav2 (t=8s) : 서버가 주는 목표로 자율주행 ----
    nav2 = TimerAction(
        period=8.0,
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

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument('rviz', default_value='true'),
        DeclareLaunchArgument(
            'map', default_value=os.path.expanduser('~/maps/demo_map.yaml'),
            description='저장된 맵 yaml 경로'),
        cam_mount,
        cam_optical,
        victim_mapper,
        victim_inspector,
        victim_obstacle,
        localization,
        rviz,
        nav2,
    ])
