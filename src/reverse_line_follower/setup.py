from setuptools import find_packages, setup

package_name = 'reverse_line_follower'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='k',
    maintainer_email='0307102bj41@gmail.com',
    description='후진 구동 기반 라인트레이싱 노드. '
                '/robot_state 의 stage==TRACE 일 때만 동작.',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            # 실행: ros2 run reverse_line_follower reverse_line_follower
            'reverse_line_follower = reverse_line_follower.reverse_line_follower:main',
        ],
    },
)