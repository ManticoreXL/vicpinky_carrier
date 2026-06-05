#!/usr/bin/env python3
"""
vicpinky_carrier - sim.launch.py

개발/검증용. 실제 로봇의 bringup 자리를 Gazebo 시뮬레이터로 대체한다.
  Gazebo(turtlebot3_world)  +  bringup_pc.launch.py(use_sim_time:=true)

가제보와 두뇌 계층의 인터페이스(/scan, /odom, TF, /cmd_vel)가 실제 로봇과 동일하므로
나중에 실제 로봇으로 넘어갈 때는 이 파일만 빼고 아래처럼 쓰면 된다.
  [로봇] ros2 launch turtlebot3_bringup robot.launch.py
  [PC]   ros2 launch vicpinky_carrier bringup_pc.launch.py use_sim_time:=false
"""

from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import PathJoinSubstitution
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    gazebo_launch = PathJoinSubstitution(
        [FindPackageShare('turtlebot3_gazebo'), 'launch', 'turtlebot3_world.launch.py']
    )
    brain_launch = PathJoinSubstitution(
        [FindPackageShare('vicpinky_carrier'), 'launch', 'bringup_pc.launch.py']
    )

    return LaunchDescription([
        # 로봇 계층 대체: Gazebo + TB3 (센서/오도메트리/TF 제공)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(gazebo_launch),
        ),

        # 두뇌 계층: SLAM + Nav2 + 코디네이터 (시뮬이므로 sim time 강제)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(brain_launch),
            launch_arguments={'use_sim_time': 'true'}.items(),
        ),
    ])
