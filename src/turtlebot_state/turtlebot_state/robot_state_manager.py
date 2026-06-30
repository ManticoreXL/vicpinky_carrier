#!/usr/bin/env python3
#
# robot_state_manager.py
# 로봇 한 대의 로컬 상태 노드 (초단순 토글).
#
# 상태는 ONBOARD / ACTIVE 둘뿐. 기능 노드(서비스)가 끝났다고 보고하면 토글된다.
#   - deploy(전진 하차) 서비스 완료    → ACTIVE   (내려갔음)
#   - reverse 라인트레이싱 서비스 완료  → ONBOARD  (빅핑키 위로 다시 올라갔음)
#
# 입력:  /state_update (기능노드 → 로봇)  completed_stage 로 끝낸 동작 보고
# 발행:  /robot_state  (latched)
#
# 흐름:  ONBOARD --(deploy 완료)--> ACTIVE --(reverse 완료)--> ONBOARD --> ...

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)

from turtlebot_state_msgs.msg import RobotState, StateUpdate

ONBOARD = 'ONBOARD'
ACTIVE = 'ACTIVE'

# 기능 노드가 보고한 '끝낸 동작' → 그 결과 상태
DONE_TO_STATE = {
    'DEPLOY': ACTIVE,   # 하차 완료 → 내려감
    'TRACE':  ONBOARD,  # 라인트레이싱 완료 → 올라감
}


class RobotStateManager(Node):
    def __init__(self):
        super().__init__('robot_state_manager')

        self.declare_parameter('bot_id', 'tb3_01')
        self.declare_parameter('publish_rate_hz', 2.0)

        self.bot_id = self.get_parameter('bot_id').value
        pub_hz = float(self.get_parameter('publish_rate_hz').value)

        self.state = ONBOARD

        # latched: 늦게 켜진 구독자도 마지막 상태 1개를 받음
        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        self.state_pub = self.create_publisher(RobotState, '/robot_state', latched)
        self.create_subscription(StateUpdate, '/state_update', self.on_state_update, 10)

        period = 1.0 / pub_hz if pub_hz > 0 else 0.5
        self.create_timer(period, self.publish_state)

        self.get_logger().info(
            f'🤖 [{self.bot_id}] robot_state_manager 가동. '
            f'시작={self.state}, 발행 {pub_hz:.1f}Hz')
        self.publish_state()

    def on_state_update(self, msg):
        done = msg.completed_stage.strip().upper()
        target = DONE_TO_STATE.get(done)
        if target is None:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] '{done}' 보고 — 매핑 없음. 무시.",
                throttle_duration_sec=2.0)
            return
        if target == self.state:
            return
        prev = self.state
        self.state = target
        self.get_logger().info(
            f"➡️ [{self.bot_id}] {prev} → {target} (by {msg.requester})")
        self.publish_state()

    def publish_state(self):
        m = RobotState()
        m.stage = self.state
        m.bot_id = self.bot_id
        m.stamp = self.get_clock().now().to_msg()
        self.state_pub.publish(m)


def main(args=None):
    rclpy.init(args=args)
    node = RobotStateManager()
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
