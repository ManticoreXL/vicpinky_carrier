#!/usr/bin/env python3
#
# explorer_state_manager.py
# 탐사 터틀봇(tb3_01)에 올라가는 로컬 중앙 상태 노드.
#
# 구호봇과 거의 같으나, 물품 적재(LOADING)와 배달 반복이 없어 더 단순하다.
# 탐사봇은 매핑+욜로(ACTIVE)를 한 번 수행하고 바로 복귀→주차한다.
#
# 상태 흐름(탐사봇):
#   ONBOARD →(PC:DEPLOY)→ DEPLOY →(node done)→ ACTIVE
#     ACTIVE →(node done)→ (PC:START_RETURN)→ RETURN →(node done)→ STANDBY
#     STANDBY →(PC:PARK_AUTHORIZE)→ TRACE →(빅핑키 PARK)→ PARKING →(node done)→ PARKED
#   어느 단계서든 (PC:SET_ERROR)→ ERROR (종착)
#
# 입력/발행 토픽은 구호봇과 동일 구조 (bot_id 네임스페이스).

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)

from turtlebot_state_msgs.msg import (
    RobotState, StateUpdate, PcCommand, VicpinkySignal,
)


TERMINAL_STAGES = {'PARKED', 'ERROR'}

# 탐사봇은 LOADING 이 없다. ACTIVE/TRACE 는 외부 입력 대기라 제외.
NODE_DONE_TRANSITIONS = {
    'DEPLOY':  'ACTIVE',
    'RETURN':  'STANDBY',
    'PARKING': 'PARKED',
}


class ExplorerStateManager(Node):
    def __init__(self):
        super().__init__('explorer_state_manager')

        self.declare_parameter('bot_id', 'tb3_01')
        self.declare_parameter('marker_id', 1)
        self.declare_parameter('publish_rate_hz', 2.0)

        self.bot_id = self.get_parameter('bot_id').value
        self.marker_id = int(self.get_parameter('marker_id').value)
        pub_hz = float(self.get_parameter('publish_rate_hz').value)

        self.stage = 'ONBOARD'
        self.parking_authorized = False
        self.last_changed_by = 'init'
        self.stage_seq = 0
        self._last_update_seq = None

        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        self.state_pub = self.create_publisher(
            RobotState, f'/{self.bot_id}/robot_state', latched)

        self.create_subscription(
            StateUpdate, f'/{self.bot_id}/state_update',
            self.on_state_update, 10)
        self.create_subscription(
            PcCommand, f'/{self.bot_id}/pc_command',
            self.on_pc_command, 10)
        self.create_subscription(
            VicpinkySignal, f'/{self.bot_id}/vicpinky_signal',
            self.on_vicpinky_signal, 10)

        period = 1.0 / pub_hz if pub_hz > 0 else 0.5
        self.create_timer(period, self.publish_state)

        self.get_logger().info(
            f'🛰️ [{self.bot_id}] explorer_state_manager 가동. '
            f'마커={self.marker_id}, 시작단계={self.stage}, 발행 {pub_hz:.1f}Hz')
        self.publish_state()

    def _change_stage(self, new_stage, source, *, force_park_auth=None):
        if self.stage in TERMINAL_STAGES:
            self.get_logger().warn(
                f"⛔ 종착({self.stage})에서 '{source}' 전환 시도 무시 (→ {new_stage})",
                throttle_duration_sec=2.0)
            return False
        prev = self.stage
        self.stage = new_stage
        if force_park_auth is not None:
            self.parking_authorized = force_park_auth
        self.last_changed_by = source
        self.stage_seq += 1
        self.get_logger().info(
            f"➡️ [{self.bot_id}] {prev} → {new_stage} (by {source}, seq={self.stage_seq})")
        self.publish_state()
        return True

    # ── 기능 노드 보고 ──
    def on_state_update(self, msg):
        if self.stage in TERMINAL_STAGES:
            return
        if self._last_update_seq is not None and msg.seq <= self._last_update_seq:
            self.get_logger().warn(
                f"⏮️ [{self.bot_id}] 늦은/중복 보고(seq={msg.seq}) 무시",
                throttle_duration_sec=2.0)
            return
        self._last_update_seq = msg.seq

        completed = msg.completed_stage.strip()
        if completed != self.stage:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] '{msg.requester}' '{completed}' 완료 보고했으나 "
                f"현재 '{self.stage}'. 무시.", throttle_duration_sec=2.0)
            return

        # ACTIVE 완료 → PC 의 START_RETURN 대기 (탐사봇은 GO_LOAD 가 없음)
        if completed == 'ACTIVE':
            self.get_logger().info(
                f"✅ [{self.bot_id}] ACTIVE(매핑/욜로) 완료. PC 의 START_RETURN 대기.")
            return

        # TRACE 완료 → 빅핑키 PARK 신호 대기
        if completed == 'TRACE':
            self.get_logger().info(
                f"✅ [{self.bot_id}] TRACE 완료. 빅핑키 PARK 신호 대기.")
            return

        nxt = NODE_DONE_TRANSITIONS.get(completed)
        if nxt is None:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] '{completed}' 전이 규칙 없음. 무시.")
            return
        self._change_stage(nxt, f'node:{msg.requester}')

    # ── PC 지시 ──
    def on_pc_command(self, msg):
        cmd = msg.command.strip()

        if cmd == 'SET_ERROR':
            if self.stage == 'ERROR':
                return
            prev = self.stage
            self.stage = 'ERROR'
            self.last_changed_by = 'pc'
            self.stage_seq += 1
            self.get_logger().error(
                f"🔴 [{self.bot_id}] {prev} → ERROR (PC 판정, 종착)")
            self.publish_state()
            return

        if self.stage in TERMINAL_STAGES:
            return

        if cmd == 'DEPLOY':
            if self.stage == 'ONBOARD':
                self._change_stage('DEPLOY', 'pc')
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] DEPLOY 무시 (현재 {self.stage})")

        elif cmd == 'START_RETURN':
            # 탐사봇은 매핑 끝나면 바로 복귀. ACTIVE 에서만.
            if self.stage == 'ACTIVE':
                self._change_stage('RETURN', 'pc')
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] START_RETURN 무시 (현재 {self.stage})")

        elif cmd == 'PARK_AUTHORIZE':
            if self.stage == 'STANDBY':
                self._change_stage('TRACE', 'pc', force_park_auth=True)
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] PARK_AUTHORIZE 무시 (현재 {self.stage})")

        elif cmd == 'GO_LOAD':
            # 탐사봇엔 적재가 없음
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 탐사봇은 GO_LOAD 를 처리하지 않음. 무시.")

        else:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 알 수 없는 PC 명령 '{cmd}' 무시")

    # ── 빅핑키 신호 ──
    def on_vicpinky_signal(self, msg):
        if self.stage in TERMINAL_STAGES:
            return
        sig = msg.signal.strip()
        if self.stage != 'TRACE':
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 빅핑키 '{sig}' 를 {self.stage} 에서 받음. 무시.",
                throttle_duration_sec=2.0)
            return
        if sig == 'PARK':
            self._change_stage('PARKING', 'vicpinky')
        elif sig == 'LOAD':
            # 탐사봇은 적재가 없으니 LOAD 신호는 의미 없음
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 탐사봇에 LOAD 신호. 무시.")
        else:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 알 수 없는 빅핑키 신호 '{sig}' 무시")

    def publish_state(self):
        m = RobotState()
        m.stage = self.stage
        m.parking_authorized = self.parking_authorized
        m.bot_id = self.bot_id
        m.marker_id = self.marker_id
        m.last_changed_by = self.last_changed_by
        m.stage_seq = self.stage_seq
        m.stamp = self.get_clock().now().to_msg()
        self.state_pub.publish(m)


def main(args=None):
    rclpy.init(args=args)
    node = ExplorerStateManager()
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
