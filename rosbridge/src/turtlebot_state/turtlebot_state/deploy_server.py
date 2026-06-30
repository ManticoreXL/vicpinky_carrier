#!/usr/bin/env python3
#
# Deploy service server.
#
# Provides the `/deploy` service (turtlebot_state_msgs/srv/Deploy): on request the
# robot drives straight forward for `forward_time` seconds at `forward_speed` m/s,
# then stops. Either field <= 0 falls back to the node's default parameter.
#
# Example:
#   ros2 service call /deploy turtlebot_state_msgs/srv/Deploy \
#       "{forward_time: 25.0, forward_speed: 0.0}"

import os
import time

import rclpy
from rclpy.node import Node

from turtlebot_state_msgs.srv import Deploy

# cmd_vel message type differs by distro: Humble uses Twist, newer
# distros (Jazzy, ...) use TwistStamped. Mirrors the turtlebot3_example nodes.
ros_distro = os.environ.get('ROS_DISTRO', 'humble').lower()
if ros_distro == 'humble':
    from geometry_msgs.msg import Twist as CmdVelMsg
    USE_STAMPED = False
else:
    from geometry_msgs.msg import TwistStamped as CmdVelMsg
    USE_STAMPED = True


class DeployServer(Node):

    def __init__(self):
        super().__init__('deploy_server')

        self.declare_parameter('default_forward_time', 5.0)
        self.declare_parameter('default_forward_speed', 0.1)
        self.declare_parameter('cmd_vel_topic', 'cmd_vel')
        self.declare_parameter('control_period', 0.05)

        self.default_forward_time = float(
            self.get_parameter('default_forward_time').value)
        self.default_forward_speed = float(
            self.get_parameter('default_forward_speed').value)
        cmd_vel_topic = self.get_parameter('cmd_vel_topic').value
        self.control_period = float(self.get_parameter('control_period').value)

        self.cmd_vel_pub = self.create_publisher(CmdVelMsg, cmd_vel_topic, 10)
        self.srv = self.create_service(Deploy, 'deploy', self.deploy_callback)

        self.get_logger().info(
            "Deploy service ready on '/deploy' "
            f"(cmd_vel -> '{cmd_vel_topic}', defaults: "
            f'time={self.default_forward_time}s '
            f'speed={self.default_forward_speed}m/s)')

    def make_cmd(self, linear_x):
        msg = CmdVelMsg()
        if USE_STAMPED:
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.twist.linear.x = float(linear_x)
        else:
            msg.linear.x = float(linear_x)
        return msg

    def stop_robot(self):
        # Publish a few zero-velocity commands to make sure the robot halts.
        for _ in range(5):
            self.cmd_vel_pub.publish(self.make_cmd(0.0))

    def deploy_callback(self, request, response):
        # <= 0 means "use the node default".
        forward_time = (request.forward_time
                        if request.forward_time > 0.0
                        else self.default_forward_time)
        forward_speed = (request.forward_speed
                         if request.forward_speed > 0.0
                         else self.default_forward_speed)

        self.get_logger().info(
            f'Deploy start: time={forward_time:.2f}s speed={forward_speed:.3f}m/s')

        start = time.monotonic()
        try:
            while rclpy.ok() and (time.monotonic() - start) < forward_time:
                self.cmd_vel_pub.publish(self.make_cmd(forward_speed))
                time.sleep(self.control_period)
        finally:
            self.stop_robot()

        driven = time.monotonic() - start
        response.success = True
        response.driven_time = float(driven)
        response.message = (
            f'Drove forward {driven:.2f}s at {forward_speed:.3f} m/s')
        self.get_logger().info(response.message)
        return response


def main(args=None):
    rclpy.init(args=args)
    node = DeployServer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.stop_robot()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
