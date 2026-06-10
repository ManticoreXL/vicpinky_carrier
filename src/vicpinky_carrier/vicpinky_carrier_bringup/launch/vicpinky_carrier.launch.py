import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch_ros.actions import Node

def generate_launch_description():
    # 1. vicpinky_bringup 패키지의 공유 경로 및 XML 런치 파일 경로 지정
    vicpinky_bringup_dir = get_package_share_directory('vicpinky_bringup')
    bringup_launch_path = os.path.join(vicpinky_bringup_dir, 'launch', 'bringup.launch.xml')

    # XML 런치 파일 포함 액션 정의
    include_bringup = IncludeLaunchDescription(
        AnyLaunchDescriptionSource(bringup_launch_path)
    )

    # 2. vicpinky_carrier_hardware 패키지의 ramp_action_server 노드 실행 액션 정의
    ramp_action_server_node = Node(
        package='vicpinky_carrier_hardware',
        executable='ramp_action_server',
        name='ramp_action_server',
        output='screen'
    )

    # 3. 정의된 두 액션을 하나의 LaunchDescription으로 묶어서 반환
    return LaunchDescription([
        include_bringup,
        ramp_action_server_node
    ])