#!/usr/bin/env python3
#
# robot_state_manager.py
# 터틀봇 보드 내 중앙 상태 관리 노드.
#
# 역할:
#   - 터틀봇 미션 단계 + 빅핑키 경사로 상태를 단일 진실 공급원으로 보유
#   - /robot_state 를 주기적으로 발행 (latched QoS) → 기능 노드들이 구독
#   - /state_update 를 구독 → 기능 노드의 '완료 보고'를 받아 상태 갱신
#   - 미션 단계 전이(다음 작업 결정)는 이 노드가 상태머신으로 수행
#
# 토픽:
#   발행: /robot_state   (turtlebot_state_msgs/RobotState)
#   구독: /state_update  (turtlebot_state_msgs/StateUpdate)

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)

from turtlebot_state_msgs.msg import RobotState, StateUpdate


# ── 미션 단계 전이 규칙 ──
# "방금 끝낸 단계" → "다음 단계" 매핑.
# 미션 순서를 바꾸려면 여기만 고치면 된다. (전이 지식의 단일 집중)
MISSION_TRANSITIONS = {
    'INIT':       'EXPLORING',
    'EXPLORING':  'RESCUE',
    'RESCUE':     'LINE_TRACE',
    'LINE_TRACE': 'MARKER_NAV',
    'MARKER_NAV': 'PARKING',
    'PARKING':    'PARKED',
    'PARKED':     'RETURNING',
    'RETURNING':  'DONE',
    # 'DONE' 은 종착 — 전이 없음
}

VALID_RAMP_STATES = {'Open', 'Closed'}


class RobotStateManager(Node):
    def __init__(self):
        super().__init__('robot_state_manager')

        # ── 파라미터 ──
        self.declare_parameter('publish_rate_hz', 2.0)   # /robot_state 주기 발행 주파수
        self.declare_parameter('initial_stage', 'INIT')
        pub_hz = float(self.get_parameter('publish_rate_hz').value)
        init_stage = self.get_parameter('initial_stage').value

        # ── 보유 상태 ──
        self.mission_stage = init_stage
        self.ramp_state = 'Closed'
        self.last_updated_by = 'init'
        self.mission_seq = 0

        # 기능 노드별 마지막 처리 seq (중복/늦은 보고 무시용)
        self._last_seq_by_node = {}

        # ── latched QoS (마지막 상태를 늦은 구독자에게도 전달) ──
        latched_qos = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        # ── 발행 / 구독 ──
        self.state_pub = self.create_publisher(
            RobotState, 'robot_state', latched_qos)

        # /state_update 는 이벤트성이라 일반 신뢰성 QoS면 충분
        self.update_sub = self.create_subscription(
            StateUpdate, 'state_update', self.on_state_update, 10)

        # ── 주기 발행 타이머 ──
        period = 1.0 / pub_hz if pub_hz > 0 else 0.5
        self.timer = self.create_timer(period, self.publish_state)

        self.get_logger().info(
            f'🗂️ robot_state_manager 가동. '
            f'초기 단계={self.mission_stage}, 경사로={self.ramp_state}, '
            f'발행 {pub_hz:.1f}Hz')

        # 시작 시 한 번 즉시 발행 (latched 라 늦은 구독자도 받음)
        self.publish_state()

    # ==================================================================
    # /state_update 수신 → 상태 갱신
    # ==================================================================
    def on_state_update(self, msg):
        requester = msg.requester or 'unknown'

        # ── 중복/늦은 보고 방어 ──
        last_seq = self._last_seq_by_node.get(requester)
        if last_seq is not None and msg.seq <= last_seq:
            self.get_logger().warn(
                f"⏮️ '{requester}' 의 늦은/중복 보고(seq={msg.seq} ≤ {last_seq}) 무시",
                throttle_duration_sec=2.0)
            return
        self._last_seq_by_node[requester] = msg.seq

        # ── 경사로 보고 ──
        if msg.field == 'ramp':
            rstate = msg.ramp_state.strip()
            if rstate not in VALID_RAMP_STATES:
                self.get_logger().warn(
                    f"⚠️ '{requester}' 잘못된 경사로 상태 '{rstate}' 무시")
                return
            if rstate != self.ramp_state:
                prev = self.ramp_state
                self.ramp_state = rstate
                self.last_updated_by = requester
                self.get_logger().info(
                    f"🛗 경사로 갱신: {prev} → {rstate} (by {requester})")
                self.publish_state()   # 변화 즉시 반영
            return

        # ── 미션 완료 보고 → 다음 단계로 전이 ──
        if msg.field == 'mission':
            completed = msg.completed_stage.strip()

            # 보고된 '끝낸 단계' 가 현재 단계와 다르면(이미 넘어갔거나 엉뚱함) 무시
            if completed != self.mission_stage:
                self.get_logger().warn(
                    f"⚠️ '{requester}' 가 '{completed}' 완료를 보고했으나 "
                    f"현재 단계는 '{self.mission_stage}'. 무시.",
                    throttle_duration_sec=2.0)
                return

            next_stage = MISSION_TRANSITIONS.get(completed)
            if next_stage is None:
                self.get_logger().info(
                    f"🏁 '{completed}' 은 종착 단계. 전이 없음.")
                return

            self.mission_stage = next_stage
            self.mission_seq += 1
            self.last_updated_by = requester
            self.get_logger().info(
                f"➡️ 미션 전이: {completed} → {next_stage} "
                f"(by {requester}, seq={self.mission_seq})")
            self.publish_state()   # 변화 즉시 반영
            return

        self.get_logger().warn(
            f"⚠️ '{requester}' 알 수 없는 field='{msg.field}' 무시")

    # ==================================================================
    # /robot_state 발행
    # ==================================================================
    def publish_state(self):
        msg = RobotState()
        msg.mission_stage = self.mission_stage
        msg.ramp_state = self.ramp_state
        msg.last_updated_by = self.last_updated_by
        msg.mission_seq = self.mission_seq
        msg.stamp = self.get_clock().now().to_msg()
        self.state_pub.publish(msg)


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