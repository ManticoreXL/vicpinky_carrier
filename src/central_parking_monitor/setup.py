import os
from glob import glob
from setuptools import find_packages, setup

package_name = 'central_parking_monitor'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # 💡 [중요] launch 폴더 안의 모든 런치 파일을 빌드 결과물에 포함시킵니다.
        (os.path.join('share', package_name, 'launch'), glob(os.path.join('launch', '*launch.[pxy][yma]*'))),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Kim Dong-seok',
    maintainer_email='todo@todo.com',
    description='Line tracing and automatic parking system',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            # 💡 [중요] 실행 명령어 정의 (파일명과 매칭되어야 합니다)
            'reverse_line_follower = central_parking_monitor.reverse_line_follower:main',
            'parking_controller = central_parking_monitor.parking_controller:main',
        ],
    },
)