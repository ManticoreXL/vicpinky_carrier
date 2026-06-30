from setuptools import find_packages
from setuptools import setup

package_name = 'turtlebot_state'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='js',
    maintainer_email='pjsu94@gmail.com',
    description='TurtleBot deploy service server: drives the robot forward on request.',
    license='Apache 2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'deploy_server = turtlebot_state.deploy_server:main',
        ],
    },
)
