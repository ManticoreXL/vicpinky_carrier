#!/usr/bin/env python3
#
# deploy_node.py  (turtlebot3_hardware)
# 하차(전진)를 '서비스'로 수행하는 기능 노드.  Ubuntu 24.04 / ROS 2 Jazzy
#
# 동작:
#   /deploy (turtlebot_state_msgs/srv/Deploy) 호출을 받으면
#   요청한 시간(forward_time)만큼 요청 속도(forward_speed)로 전진 후 정지하고,
#   완료 결과를 응답으로 돌려준다(호출이 끝나면 = 전진 완료).
#
#   요청 값이 0 이하이면 노드 파라미터 기본값(속도 0.5, 시간 30)을 사용한다.
#   기본 속도·시간은 실행 인자(-p forward_speed / -p forward_time)로 조절 가능하다.
#
# 참고: 이 버전은 상태매니저 연동(/robot_state 구독, /state_update 보고)을 제거하고
#       외부에서 명령으로 전진시키는 단순 서비스로 재편한 형태다.

import time

import rclpy
from rclpy.node import Node

from geometry_msgs.msg import Twist, TwistStamped
from turtlebot_state_msgs.srv import Deploy


class DeployNode(Node):
    def __init__(self):
        super().__init__('deploy_node')

        # ── 파라미터 ──
        self.declare_parameter('bot_id', 'tb3_01')
        self.declare_parameter('use_stamped', True)        # TwistStamped(기본) vs Twist
        self.declare_parameter('base_frame', 'base_link')
        self.declare_parameter('forward_speed', 0.05)       # m/s 기본값 (실행 인자로 조절)
        self.declare_parameter('forward_time', 30.0)       # s   기본값 (실행 인자로 조절)
        self.declare_parameter('control_rate_hz', 20.0)

        self.bot_id = self.get_parameter('bot_id').value
        topic = '/cmd_vel'
        self.use_stamped = bool(self.get_parameter('use_stamped').value)
        self.base_frame = self.get_parameter('base_frame').value
        self.def_speed = float(self.get_parameter('forward_speed').value)
        self.def_time = float(self.get_parameter('forward_time').value)
        self.rate_hz = float(self.get_parameter('control_rate_hz').value)

        self._busy = False        # 동시 호출 방지

        # ── 발행 ──
        msg_type = TwistStamped if self.use_stamped else Twist
        self.cmd_pub = self.create_publisher(msg_type, topic, 10)

        # ── 서비스 ──
        self.srv = self.create_service(Deploy, '/deploy', self.on_deploy)

        self.get_logger().info(
            f'🚚 [{self.bot_id}] deploy 서비스 대기. /deploy 호출 시 전진 — '
            f'기본 속도={self.def_speed:.2f}m/s, 기본 시간={self.def_time:.1f}s, '
            f'cmd={topic}, stamped={self.use_stamped}')

    # ── 서비스 콜백: 요청한 시간만큼 전진(완료될 때까지 블로킹) ──
    def on_deploy(self, req, res):
        if self._busy:
            res.success = False
            res.driven_time = 0.0
            res.message = '이미 전진 동작 수행 중'
            self.get_logger().warn(f'⚠️ [{self.bot_id}] 중복 호출 거부')
            return res

        # 요청 값이 양수면 그 값, 아니면 노드 기본값
        speed = req.forward_speed if req.forward_speed > 0.0 else self.def_speed
        duration = req.forward_time if req.forward_time > 0.0 else self.def_time

        self._busy = True
        self.get_logger().info(
            f'➡️ [{self.bot_id}] 전진 시작 — {duration:.1f}s @ {speed:.2f}m/s')

        period = 1.0 / self.rate_hz if self.rate_hz > 0 else 0.05
        start = time.monotonic()
        try:
            while rclpy.ok():
                if time.monotonic() - start >= duration:
                    break
                self._publish_cmd(speed)
                time.sleep(period)
        finally:
            self._stop()
            self._busy = False

        driven = time.monotonic() - start
        res.success = True
        res.driven_time = float(driven)
        res.message = f'{driven:.1f}s 전진 완료 (@ {speed:.2f}m/s)'
        self.get_logger().info(f'✅ [{self.bot_id}] 전진 완료 ({driven:.1f}s)')
        return res

    # ── cmd_vel 발행 (stamped/unstamped 공용) ──
    def _publish_cmd(self, vx):
        if self.use_stamped:
            m = TwistStamped()
            m.header.stamp = self.get_clock().now().to_msg()
            m.header.frame_id = self.base_frame
            m.twist.linear.x = float(vx)
            self.cmd_pub.publish(m)
        else:
            m = Twist()
            m.linear.x = float(vx)
            self.cmd_pub.publish(m)

    def _stop(self):
        self._publish_cmd(0.0)


def main(args=None):
    rclpy.init(args=args)
    node = DeployNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()