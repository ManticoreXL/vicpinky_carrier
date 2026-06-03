import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource, AnyLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

def generate_launch_description():
    # 1. 패키지 경로 설정
    vicpinky_carrier_bringup_dir = get_package_share_directory('vicpinky_carrier_bringup')
    vic_pinky_bringup_dir = get_package_share_directory('vicpinky_bringup')

    # 2. Launch Configurations 생성
    use_sim_time = LaunchConfiguration('use_sim_time')
    accel_limit = LaunchConfiguration('accel_limit')
    decel_limit = LaunchConfiguration('decel_limit')
    ang_accel_limit = LaunchConfiguration('ang_accel_limit')
    ang_decel_limit = LaunchConfiguration('ang_decel_limit')

    # 3. Launch Arguments 선언
    declare_use_sim_time_cmd = DeclareLaunchArgument(
        'use_sim_time', 
        default_value='false', 
        description='Use simulation (Gazebo) clock if true'
    )
    declare_accel_limit_cmd = DeclareLaunchArgument(
        'accel_limit', 
        default_value='0.4', 
        description='Linear acceleration limit'
    )
    declare_decel_limit_cmd = DeclareLaunchArgument(
        'decel_limit', 
        default_value='1.0', 
        description='Linear deceleration limit'
    )
    declare_ang_accel_limit_cmd = DeclareLaunchArgument(
        'ang_accel_limit', 
        default_value='1.0', 
        description='Angular acceleration limit'
    )
    declare_ang_decel_limit_cmd = DeclareLaunchArgument(
        'ang_decel_limit', 
        default_value='1.5', 
        description='Angular deceleration limit'
    )

    # 4. IncludeLaunchDescription: 기본 모터 및 URDF 로드 (공식 패키지)
    upload_launch = IncludeLaunchDescription(
        AnyLaunchDescriptionSource(
            os.path.join(vic_pinky_bringup_dir, 'launch', 'upload.launch.xml') # 오리지널 코드에서 참조하던 경로 추정
            # os.path.join(vicpinky_carrier_description_dir, 'launch', 'upload.launch.xml') # 변경 목표
        ),
        launch_arguments={'use_sim_time': use_sim_time}.items()
    )

    # 5. Node: 빅핑키 주행 모터 노드 실행
    vicpinky_base_node = Node(
        package='vicpinky_bringup',
        executable='bringup',
        name='vic_pinky_bringup',
        output='screen',
        parameters=[{
            'accel_limit': accel_limit,
            'decel_limit': decel_limit,
            'ang_accel_limit': ang_accel_limit,
            'ang_decel_limit': ang_decel_limit
        }]
    )

    # 6. TODO: 커스텀 하드웨어 노드 추가

    # LaunchDescription 객체 생성 및 반환
    ld = LaunchDescription()

    # Arguments 추가
    ld.add_action(declare_use_sim_time_cmd)
    ld.add_action(declare_accel_limit_cmd)
    ld.add_action(declare_decel_limit_cmd)
    ld.add_action(declare_ang_accel_limit_cmd)
    ld.add_action(declare_ang_decel_limit_cmd)

    # Nodes 및 Includes 추가
    ld.add_action(upload_launch)
    ld.add_action(vicpinky_base_node)

    return ld