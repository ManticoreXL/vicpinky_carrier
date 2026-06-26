#!/usr/bin/env python3
#
# deploy_node.py  (turtlebot3_hardware)
# 빅핑키에서 하차(DEPLOY)를 수행하는 기능 노드.  Ubuntu 24.04 / ROS 2 Jazzy
#
# 전제: DEPLOY 진입 시 로봇은 빅핑키 위에 정차해 있고 경사로(다리)는 이미 내려와 있다.
#       이 노드는 경사로를 따라 천천히 전진해 지상으로 내려간 뒤 완료를 보고한다.
#
# 동작:
#   /robot_state(stage) 구독 → stage 가 DEPLOY 로 들어오면 1회 전진 실행(개루프 시간)
#   지정 시간 전진 → 정지 → /state_update(completed='DEPLOY') 발행
#   stage 가 DEPLOY 가 아니면 cmd_vel 을 발행하지 않는다(제어권 양보).
#
# 사용 필드(터틀봇 측 최소):
#   읽기: RobotState.stage, RobotState.stage_seq
#   쓰기: StateUpdate.requester / completed_stage / seq / stamp

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)

from geometry_msgs.msg import Twist, TwistStamped
from turtlebot_state_msgs.msg import RobotState, StateUpdate

DEPLOY = 'DEPLOY'


class DeployNode(Node):
    def __init__(self):
        super().__init__('deploy_node')

        # ── 파라미터 ──
        self.declare_parameter('bot_id', 'tb3_01')
        self.declare_parameter('use_stamped', True)        # TwistStamped(기본) vs Twist
        self.declare_parameter('base_frame', 'base_link')
        self.declare_parameter('forward_speed', 0.07)      # m/s, 천천히
        self.declare_parameter('forward_time', 12.0)       # s — 경사로+플랫폼 거리에 맞춰 조정
        self.declare_parameter('control_rate_hz', 20.0)

        self.bot_id = self.get_parameter('bot_id').value
        topic = '/cmd_vel'
        self.use_stamped = bool(self.get_parameter('use_stamped').value)
        self.base_frame = self.get_parameter('base_frame').value
        self.forward_speed = float(self.get_parameter('forward_speed').value)
        self.forward_time = float(self.get_parameter('forward_time').value)
        rate = float(self.get_parameter('control_rate_hz').value)

        # ── 내부 상태 ──
        self.stage = 'ONBOARD'
        self.stage_seq = 0
        self._driving = False
        self._done_for_seq = None        # 이 stage_seq 의 DEPLOY 는 이미 완료
        self._drive_start = None

        # ── QoS: 상태매니저의 latched(/robot_state)와 호환되게 ──
        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        # ── 발행 ──
        msg_type = TwistStamped if self.use_stamped else Twist
        self.cmd_pub = self.create_publisher(msg_type, topic, 10)
        self.update_pub = self.create_publisher(StateUpdate, '/state_update', 10)

        # ── 구독: 현재 상태(늦게 떠도 최신 상태 수신) ──
        self.create_subscription(RobotState, '/robot_state',
                                 self.on_robot_state, latched)

        # ── 제어 루프 ──
        period = 1.0 / rate if rate > 0 else 0.05
        self.create_timer(period, self.control_loop)

        self.get_logger().info(
            f'🚚 [{self.bot_id}] deploy_node 가동. cmd={topic}, '
            f'속도={self.forward_speed:.2f}m/s, 시간={self.forward_time:.1f}s, '
            f'stamped={self.use_stamped}')

    # ── 현재 상태 수신 ──
    def on_robot_state(self, msg):
        self.stage = msg.stage
        self.stage_seq = msg.stage_seq

        if self.stage == DEPLOY:
            # 이 seq 에서 아직 안 끝냈고 주행 중도 아니면 → 하차 시작
            if not self._driving and self._done_for_seq != self.stage_seq:
                self._start_drive()
        else:
            # DEPLOY 가 아닌데 주행 중이면 즉시 중단 (예: SET_ERROR)
            if self._driving:
                self.get_logger().warn(
                    f'⚠️ [{self.bot_id}] DEPLOY 중 stage={self.stage} 전환 → 하차 중단')
                self._stop()
                self._driving = False

    def _start_drive(self):
        self._driving = True
        self._drive_start = self.get_clock().now()
        self.get_logger().info(
            f'➡️ [{self.bot_id}] 하차 시작 — 경사로 전진 {self.forward_time:.1f}s')

    # ── 제어 루프 ──
    def control_loop(self):
        if not self._driving:
            return
        elapsed = (self.get_clock().now() - self._drive_start).nanoseconds / 1e9
        if elapsed < self.forward_time:
            self._publish_cmd(self.forward_speed)
        else:
            self._stop()
            self._driving = False
            self._done_for_seq = self.stage_seq
            self._report_done()
            self.get_logger().info(f'✅ [{self.bot_id}] 하차 완료 → state_update(DEPLOY)')

    # ── cmd_vel 발행 (stamped/unstamped 공용) ──
    def _publish_cmd(self, vx):
        if self.use_stamped:
            m = TwistStamped()
            m.header.stamp = self.get_clock().now().to_msg()
            m.header.frame_id = self.base_frame
            m.twist.linear.x = vx
            self.cmd_pub.publish(m)
        else:
            m = Twist()
            m.linear.x = vx
            self.cmd_pub.publish(m)

    def _stop(self):
        self._publish_cmd(0.0)

    def _report_done(self):
        u = StateUpdate()
        u.requester = self.get_name()
        u.completed_stage = DEPLOY
        u.seq = self.stage_seq 
        u.stamp = self.get_clock().now().to_msg()
        self.update_pub.publish(u)


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