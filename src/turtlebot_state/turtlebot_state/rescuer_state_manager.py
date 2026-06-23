#!/usr/bin/env python3
#
# rescuer_state_manager.py
# 구호 터틀봇(tb3_02~tb3_04) 각각에 1개씩 올라가는 로컬 중앙 상태 노드.
#
# 목적:
#   그 로봇 한 대의 작업 단계를 보유하고, 기능 노드들이 이 상태만 보고
#   "지금 내가 동작할 차례인가"를 간단히 판단하게 한다.
#
# 상태를 바꾸는 입력 3가지:
#   1) 기능 노드 보고  /{bot_id}/state_update   (아래→위, 대부분의 전이)
#   2) PC 지시         /{bot_id}/pc_command     (위→아래: 주차허가/ERROR/하차/복귀)
#   3) 빅핑키 신호     /{bot_id}/vicpinky_signal (빅핑키→아래: 올라온 뒤 LOAD/PARK 분기)
#
# 발행:
#   /{bot_id}/robot_state  (latched) — 기능 노드들이 구독
#
# 상태 흐름(구호봇):
#   ONBOARD →(PC:DEPLOY)→ DEPLOY →(node done)→ ACTIVE
#     ACTIVE →(node done)→ TRACE  →(빅핑키 LOAD)→ LOADING →(node done)→ DEPLOY ... (반복)
#     ACTIVE →(node done, 배달 다 끝)→ (PC:START_RETURN)→ RETURN →(node done)→ STANDBY
#     STANDBY →(PC:PARK_AUTHORIZE)→ TRACE →(빅핑키 PARK)→ PARKING →(node done)→ PARKED
#   어느 단계서든 (PC:SET_ERROR)→ ERROR (종착)

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)

from turtlebot_state_msgs.msg import (
    RobotState, StateUpdate, PcCommand, VicpinkySignal,
)


# 종착 상태 — 한번 들어가면 어떤 입력도 무시
TERMINAL_STAGES = {'PARKED', 'ERROR'}

# 기능 노드의 '완료 보고'로 일어나는 전이 (아래→위)
#   완료된 단계 → 다음 단계
# 단, 외부 입력을 기다리는 단계는 여기 넣지 않는다:
#   - ACTIVE 완료: PC 가 사람 리스트 개수로 또배달(GO_LOAD) vs 복귀(START_RETURN)
#                  중 하나를 명령할 때까지 ACTIVE 에 머문다.
#   - TRACE 완료: 빅핑키가 LOAD/PARK 신호를 줄 때까지 TRACE 에 머문다.
#   - STANDBY: PC 의 PARK_AUTHORIZE 를 기다린다.
#   - ONBOARD: PC 의 DEPLOY 를 기다린다.
NODE_DONE_TRANSITIONS = {
    'DEPLOY':  'ACTIVE',   # 하차 완료 → 임무 수행
    'LOADING': 'DEPLOY',   # 물품 적재 완료 → 다시 하차
    'RETURN':  'STANDBY',  # 충전소 도착 → 대기
    'PARKING': 'PARKED',   # 주차 완료 → 종착
    # 'ACTIVE' 와 'TRACE' 는 의도적으로 제외 (외부 입력 대기)
}


class RescuerStateManager(Node):
    def __init__(self):
        super().__init__('rescuer_state_manager')

        # ── 파라미터 ──
        self.declare_parameter('bot_id', 'tb3_02')
        self.declare_parameter('marker_id', 2)        # 주차 마커 번호
        self.declare_parameter('publish_rate_hz', 2.0)

        self.bot_id = self.get_parameter('bot_id').value
        self.marker_id = int(self.get_parameter('marker_id').value)
        pub_hz = float(self.get_parameter('publish_rate_hz').value)

        # ── 보유 상태 ──
        self.stage = 'ONBOARD'
        self.parking_authorized = False
        self.last_changed_by = 'init'
        self.stage_seq = 0

        # 입력별 마지막 처리 seq (state_update 중복 방어)
        self._last_update_seq = None

        # ── latched QoS ──
        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        # ── 발행: 통합 상태 ──
        self.state_pub = self.create_publisher(
            RobotState, f'/{self.bot_id}/robot_state', latched)

        # ── 구독 3종 ──
        self.create_subscription(
            StateUpdate, f'/{self.bot_id}/state_update',
            self.on_state_update, 10)
        self.create_subscription(
            PcCommand, f'/{self.bot_id}/pc_command',
            self.on_pc_command, 10)
        self.create_subscription(
            VicpinkySignal, f'/{self.bot_id}/vicpinky_signal',
            self.on_vicpinky_signal, 10)

        # ── 주기 발행 ──
        period = 1.0 / pub_hz if pub_hz > 0 else 0.5
        self.create_timer(period, self.publish_state)

        self.get_logger().info(
            f'🚑 [{self.bot_id}] rescuer_state_manager 가동. '
            f'마커={self.marker_id}, 시작단계={self.stage}, 발행 {pub_hz:.1f}Hz')
        self.publish_state()

    # ==================================================================
    # 공통: 단계 전환
    # ==================================================================
    def _change_stage(self, new_stage, source, *, force_park_auth=None):
        if self.stage in TERMINAL_STAGES:
            self.get_logger().warn(
                f"⛔ 종착 상태({self.stage})에서 '{source}' 의 전환 시도 무시 "
                f"(→ {new_stage})", throttle_duration_sec=2.0)
            return False
        prev = self.stage
        self.stage = new_stage
        if force_park_auth is not None:
            self.parking_authorized = force_park_auth
        self.last_changed_by = source
        self.stage_seq += 1
        self.get_logger().info(
            f"➡️ [{self.bot_id}] {prev} → {new_stage} "
            f"(by {source}, seq={self.stage_seq})")
        self.publish_state()
        return True

    # ==================================================================
    # 1) 기능 노드 보고 (아래→위)
    # ==================================================================
    def on_state_update(self, msg):
        if self.stage in TERMINAL_STAGES:
            return

        # 중복/늦은 보고 방어
        if self._last_update_seq is not None and msg.seq <= self._last_update_seq:
            self.get_logger().warn(
                f"⏮️ [{self.bot_id}] 늦은/중복 보고(seq={msg.seq}) 무시",
                throttle_duration_sec=2.0)
            return
        self._last_update_seq = msg.seq

        completed = msg.completed_stage.strip()

        # 보고된 '끝낸 단계'가 현재 단계와 다르면 무시 (이미 넘어갔거나 엉뚱함)
        if completed != self.stage:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] '{msg.requester}' 가 '{completed}' 완료 보고했으나 "
                f"현재 '{self.stage}'. 무시.", throttle_duration_sec=2.0)
            return

        # ── ACTIVE 완료는 자동 전이하지 않음 ──
        # 또 배달(TRACE→LOADING) 인지 복귀(RETURN) 인지는 PC 가 사람 리스트
        # 개수를 보고 GO_LOAD / START_RETURN 으로 명령한다. 그때까지 ACTIVE 유지.
        if completed == 'ACTIVE':
            self.get_logger().info(
                f"✅ [{self.bot_id}] ACTIVE(배달 1건) 완료 보고 접수. "
                f"PC 의 GO_LOAD/START_RETURN 명령 대기.")
            return

        # ── TRACE 완료도 자동 전이하지 않음 ──
        # 빅핑키가 올라온 것을 인식해 LOAD/PARK 신호를 줄 때까지 대기.
        if completed == 'TRACE':
            self.get_logger().info(
                f"✅ [{self.bot_id}] TRACE(빅핑키 진입) 완료 보고 접수. "
                f"빅핑키 LOAD/PARK 신호 대기.")
            return

        # ── 일반 전이 ──
        nxt = NODE_DONE_TRANSITIONS.get(completed)
        if nxt is None:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] '{completed}' 완료에 대한 전이 규칙 없음. 무시.")
            return
        self._change_stage(nxt, f'node:{msg.requester}')

    # ==================================================================
    # 2) PC 지시 (위→아래)
    # ==================================================================
    def on_pc_command(self, msg):
        cmd = msg.command.strip()

        # ERROR 는 종착 상태에서도 받을 수 있어야 하나, 이미 종착이면 의미 없음
        if cmd == 'SET_ERROR':
            if self.stage == 'ERROR':
                return
            # ERROR 는 강제 전환 (종착 가드 우회)
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
            # 하차 시작은 ONBOARD 에서만
            if self.stage == 'ONBOARD':
                self._change_stage('DEPLOY', 'pc')
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] DEPLOY 지시 무시 (현재 {self.stage})")

        elif cmd == 'GO_LOAD':
            # 아직 배달할 사람 남음 → 빅핑키로 올라가 물품 받으러. ACTIVE 에서만.
            if self.stage == 'ACTIVE':
                self._change_stage('TRACE', 'pc')
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] GO_LOAD 무시 (현재 {self.stage})")

        elif cmd == 'START_RETURN':
            # 배달 종료 → 복귀. 배달 완료 직후인 ACTIVE 에서만.
            if self.stage == 'ACTIVE':
                self._change_stage('RETURN', 'pc')
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] START_RETURN 무시 (현재 {self.stage})")

        elif cmd == 'PARK_AUTHORIZE':
            # 주차 차례 허가 → STANDBY 에서만. 허가 플래그를 세우고 TRACE 로.
            if self.stage == 'STANDBY':
                self._change_stage('TRACE', 'pc', force_park_auth=True)
            else:
                self.get_logger().warn(
                    f"⚠️ [{self.bot_id}] PARK_AUTHORIZE 무시 (현재 {self.stage})")

        else:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 알 수 없는 PC 명령 '{cmd}' 무시")

    # ==================================================================
    # 3) 빅핑키 신호 (빅핑키→아래)
    # ==================================================================
    def on_vicpinky_signal(self, msg):
        if self.stage in TERMINAL_STAGES:
            return

        sig = msg.signal.strip()

        # 빅핑키 신호는 'TRACE 로 올라가 빅핑키 위에 도착' 한 상태에서만 의미 있음
        if self.stage != 'TRACE':
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 빅핑키 '{sig}' 신호를 TRACE 아닌 "
                f"{self.stage} 에서 받음. 무시.", throttle_duration_sec=2.0)
            return

        if sig == 'LOAD':
            # 아직 구호자 남음 → 물품 받으러
            self._change_stage('LOADING', 'vicpinky')
        elif sig == 'PARK':
            # 주차 차례 → 주차 동작
            self._change_stage('PARKING', 'vicpinky')
        else:
            self.get_logger().warn(
                f"⚠️ [{self.bot_id}] 알 수 없는 빅핑키 신호 '{sig}' 무시")

    # ==================================================================
    # 발행
    # ==================================================================
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
    node = RescuerStateManager()
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
