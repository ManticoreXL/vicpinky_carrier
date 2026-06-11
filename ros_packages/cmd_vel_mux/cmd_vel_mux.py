#!/usr/bin/env python3
"""
cmd_vel 우선순위 믹서 (수동 > 자율)

  /{robot}/cmd_vel_manual  (수동, 우선)  ─┐
  /{robot}/cmd_vel_nav     (자율 nav2)   ─┤→ 믹서 →  /{robot}/cmd_vel  (로봇)
                                          │
  - 최근 timeout(기본 0.5s) 안에 수동 명령이 오면 → 수동만 통과 (자율 차단)
  - 수동이 끊기면 → 자율 통과
  - 둘 다 없으면 → 정지(0) 발행

사용:
  python3 cmd_vel_mux.py --robot tb3_01                # TwistStamped (tb3 기본)
  python3 cmd_vel_mux.py --robot vicpinky --no-stamped # Twist
"""
import argparse
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist, TwistStamped


class CmdVelMux(Node):
    def __init__(self, robot: str, stamped: bool, timeout: float, rate: float):
        super().__init__(f'{robot}_cmd_vel_mux')
        self.stamped = stamped
        self.timeout = timeout
        msg_type = TwistStamped if stamped else Twist

        self._manual = None
        self._manual_t = 0.0
        self._nav = None
        self._nav_t = 0.0

        ns = f'/{robot}'
        self.create_subscription(msg_type, f'{ns}/cmd_vel_manual', self._on_manual, 10)
        self.create_subscription(msg_type, f'{ns}/cmd_vel_nav',    self._on_nav,    10)
        self.pub = self.create_publisher(msg_type, f'{ns}/cmd_vel', 10)

        self.create_timer(1.0 / rate, self._tick)
        self.get_logger().info(
            f'cmd_vel_mux 시작: {ns}/cmd_vel_manual(우선) + {ns}/cmd_vel_nav → {ns}/cmd_vel '
            f'[{"TwistStamped" if stamped else "Twist"}, timeout={timeout}s]'
        )

    def _on_manual(self, msg):
        self._manual = msg
        self._manual_t = time.time()

    def _on_nav(self, msg):
        self._nav = msg
        self._nav_t = time.time()

    def _zero(self):
        m = TwistStamped() if self.stamped else Twist()
        return m

    def _tick(self):
        now = time.time()
        manual_active = self._manual is not None and (now - self._manual_t) < self.timeout
        nav_active    = self._nav    is not None and (now - self._nav_t)    < self.timeout

        if manual_active:
            out = self._manual          # 수동 우선
        elif nav_active:
            out = self._nav             # 자율
        else:
            out = self._zero()          # 둘 다 없음 → 정지

        if self.stamped:
            out.header.stamp = self.get_clock().now().to_msg()
        self.pub.publish(out)


def main():
    ap = argparse.ArgumentParser(description='cmd_vel 우선순위 믹서 (수동 > 자율)')
    ap.add_argument('--robot', default='tb3_01', help='로봇 ID (네임스페이스)')
    ap.add_argument('--timeout', type=float, default=0.5, help='수동/자율 활성 판단 시간(초)')
    ap.add_argument('--rate', type=float, default=20.0, help='출력 발행 주기(Hz)')
    ap.add_argument('--no-stamped', dest='stamped', action='store_false',
                    help='Twist 사용 (기본은 TwistStamped)')
    ap.set_defaults(stamped=True)
    args = ap.parse_args()

    rclpy.init()
    node = CmdVelMux(args.robot, args.stamped, args.timeout, args.rate)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
