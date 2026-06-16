#!/usr/bin/env python3
"""
OMX Teleop 브릿지 노드

리더암의 관절 상태를 그대로 팔로우암 명령으로 전달.
컴퓨터 또는 라즈베리파이 어디서든 실행 가능.

토픽 흐름:
  /omx/leader_state (JointState)  →  /omx/joint_commands (Float32MultiArray)
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Float32MultiArray
import numpy as np


class OMXTeleopBridgeNode(Node):
    def __init__(self) -> None:
        super().__init__("omx_teleop_bridge_node")

        # 스케일 파라미터: 리더암과 팔로우암의 관절 방향/범위가 다를 경우 조정
        # 기본값 1.0 = 그대로 전달
        self.declare_parameter("scale", 1.0)
        self.scale = self.get_parameter("scale").get_parameter_value().double_value

        # 안전 제한 (radian)
        self.declare_parameter("joint_limit", 6.28)
        self.joint_limit = self.get_parameter("joint_limit").get_parameter_value().double_value

        self.cmd_pub = self.create_publisher(
            Float32MultiArray, "/omx/joint_commands", 10
        )
        self.leader_sub = self.create_subscription(
            JointState, "/omx/leader_state", self._leader_callback, 10
        )

        self.get_logger().info("★ Teleop 브릿지 시작. 리더암 → 팔로우암 ★")
        self.get_logger().info(
            f"  scale={self.scale}, joint_limit=±{self.joint_limit:.2f} rad"
        )

    def _leader_callback(self, msg: JointState) -> None:
        if len(msg.position) < 6:
            return

        positions = np.array(msg.position[:6], dtype=np.float32)

        # 스케일 적용
        positions = positions * self.scale

        # 관절 범위 클램핑 (안전)
        positions = np.clip(positions, -self.joint_limit, self.joint_limit)

        cmd = Float32MultiArray()
        cmd.data = positions.tolist()
        self.cmd_pub.publish(cmd)

        self.get_logger().info(
            f"[Teleop] 명령 전송: {[f'{v:.3f}' for v in positions]}",
            throttle_duration_sec=1.0
        )


def main(args=None) -> None:
    rclpy.init(args=args)
    node = OMXTeleopBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()