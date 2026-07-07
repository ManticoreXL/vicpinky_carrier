import os
from glob import glob
from setuptools import find_packages, setup

package_name = 'turtlebot_state'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # launch 파일 설치 (launch/ 폴더의 *.launch.py)
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
        # 맵 파일 설치 (map/ 폴더의 모든 파일: .yaml, .pgm)
        (os.path.join('share', package_name, 'map'), glob('map/*')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='k',
    maintainer_email='0307102bj41@gmail.com',
    description='터틀봇 로컬 중앙 상태 관리 노드 및 구동 launch',
    license='Apache-2.0',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
            'robot_state_manager = turtlebot_state.robot_state_manager:main',
            'deploy_node = turtlebot_state.deploy_node:main',
            'line_tracer_node = turtlebot_state.line_tracer_node:main',
        ],
    },
)