#!/usr/bin/env python3
#
# 후진 구동 기반 라인트레이싱 및 자율 제어권 양보 노드 (적외선 센서 개조 버전)
# 개발: 김동석
#

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile, QoSReliabilityPolicy,
    QoSDurabilityPolicy, QoSHistoryPolicy,
)
from gpiozero import DigitalInputDevice
from geometry_msgs.msg import TwistStamped

# 로컬 중앙 상태 노드가 발행하는 통합 상태
from turtlebot_state_msgs.msg import RobotState

# 하드웨어 핀 매핑 (BCM 기준)
LEFT_PIN = 22
RIGHT_PIN = 24

class ReverseLineFollowerNode(Node):

    def __init__(self):
        super().__init__('reverse_line_follower_node')

        self.declare_parameter('bot_id', 'tb3_01')
        self.bot_id = self.get_parameter('bot_id').value

        qos = QoSProfile(depth=10)

        # cmd_vel — 브링업이 네임스페이스 없이 /cmd_vel 을 구독하므로 그대로 발행.
        # (로봇 구분은 ROS_DOMAIN_ID 로 함)
        self.cmd_pub = self.create_publisher(TwistStamped, '/cmd_vel', qos)

        # 로컬 중앙 노드의 /robot_state 는 latched(TRANSIENT_LOCAL) 로 발행되므로
        # 구독 QoS 도 동일하게 맞춰야 연결된다.
        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )
        self.state_sub = self.create_subscription(
            RobotState, '/robot_state', self._state_cb, latched)
        
        self.left_sensor = DigitalInputDevice(LEFT_PIN, pull_up=False)
        self.right_sensor = DigitalInputDevice(RIGHT_PIN, pull_up=False)
        
        # 기본 상태를 대기(False) 상태로 변경하여 초기 구동 시 제어권 간섭 방지
        self.is_tracing_active = False  
        
        self.linear_speed = 0.03       
        self.turn_linear = 0.03        
        self.base_turn_angular = 0.08
        self.max_turn_angular = 0.25
        self.turn_step = 0.04

        self.LEFT_TURN_SIGN = +1   
        self.RIGHT_TURN_SIGN = -1  

        self.current_turn_angular = 0.0
        self.last_sensor_state = (None, None)

        self.timer_period = 0.05
        self.timer = self.create_timer(self.timer_period, self.control_loop)

        self.get_logger().info(
            f"🚀 [{self.bot_id} 라인트레이서] 노드 가동. "
            f"상태 TRACE 진입 대기 중...")

    def _state_cb(self, msg):
        """ /robot_state 의 stage 에 따라 라인트레이싱 활성화/비활성화.
            stage == 'TRACE' 일 때만 동작하고, 그 외 단계에서는 제어권을 양보한다.
            (TRACE 동안 다리의 검은 선을 따라 빅핑키 위로 올라감. '다 올라옴'
             판단과 다음 행동 분기는 빅핑키 카메라가 마커 매칭으로 처리하므로,
             이 노드는 완료 보고를 하지 않는다.) """
        should_trace = (msg.stage == 'TRACE')

        if should_trace and not self.is_tracing_active:
            self.is_tracing_active = True
            self.get_logger().warn(
                f"🟢 [{self.bot_id} 라인트레이서] TRACE 진입! 라인트레이싱 시작 "
                f"(parking_authorized={msg.parking_authorized})")

        elif not should_trace and self.is_tracing_active:
            # TRACE 가 아닌 단계로 바뀜 → 작동 중지하고 제어권 양보
            self.is_tracing_active = False
            self.get_logger().error(
                f"🛑 [{self.bot_id} 라인트레이서] stage={msg.stage} 수신. "
                f"제어권을 양보하고 대기합니다.")

            # 관성 진행을 막기 위해 정지 명령 3회 발행
            for _ in range(3):
                stop_msg = TwistStamped()
                stop_msg.header.stamp = self.get_clock().now().to_msg()
                stop_msg.header.frame_id = f'{self.bot_id}/base_link'
                stop_msg.twist.linear.x = 0.0
                stop_msg.twist.angular.z = 0.0
                self.cmd_pub.publish(stop_msg)

    def control_loop(self):
        # 활성화 상태가 아니면 센서를 읽지 않고 cmd_vel 발행도 중단 (외부 노드 충돌 방지)
        if not self.is_tracing_active:
            return

        l_val = self.left_sensor.value
        r_val = self.right_sensor.value
        state = (l_val, r_val)

        twist_msg = TwistStamped()
        twist_msg.header.stamp = self.get_clock().now().to_msg()
        # frame_id 는 TF 프레임 이름. 브링업이 네임스페이스 없이 뜨면 'base_link'
        # 가 맞을 수 있으나, TwistStamped 의 frame_id 는 대개 모터 드라이버가
        # 무시하므로 주행에는 영향 없음. TF 경고가 뜨면 'base_link' 로 변경.
        twist_msg.header.frame_id = f'{self.bot_id}/base_link'

        if state == (1, 1):
            twist_msg.twist.linear.x = -self.linear_speed
            twist_msg.twist.angular.z = 0.0
            self.current_turn_angular = 0.0
            status = "⬇️ 후진 직진 (정중앙 주행 / 검은 바닥 안착)"

        elif state == (1, 0):
            target_sign = self.LEFT_TURN_SIGN
            if self.current_turn_angular * target_sign <= 0:
                self.current_turn_angular = self.base_turn_angular * target_sign
            else:
                self.current_turn_angular += self.turn_step * target_sign
                if abs(self.current_turn_angular) > self.max_turn_angular:
                    self.current_turn_angular = self.max_turn_angular * target_sign
            
            twist_msg.twist.linear.x = -self.turn_linear
            twist_msg.twist.angular.z = self.current_turn_angular
            status = f"🔄 좌회전 보정 (후면 우측 이동, angular={self.current_turn_angular:.2f})"

        elif state == (0, 1):
            target_sign = self.RIGHT_TURN_SIGN
            if self.current_turn_angular * target_sign <= 0:
                self.current_turn_angular = self.base_turn_angular * target_sign
            else:
                self.current_turn_angular += self.turn_step * target_sign
                if abs(self.current_turn_angular) > self.max_turn_angular:
                    self.current_turn_angular = self.max_turn_angular * target_sign
            
            twist_msg.twist.linear.x = -self.turn_linear
            twist_msg.twist.angular.z = self.current_turn_angular
            status = f"🔄 우회전 보정 (후면 좌측 이동, angular={self.current_turn_angular:.2f})"

        elif state == (0, 0):
            twist_msg.twist.linear.x = -self.linear_speed
            twist_msg.twist.angular.z = 0.0
            self.current_turn_angular = 0.0
            status = "⬜ 흰색 영역 감지 (PC 신호 대기하며 후진 유지)"

        else:
            twist_msg.twist.linear.x = 0.0
            twist_msg.twist.angular.z = 0.0
            status = "⚠️ 예외 상태 - 정지"

        self.cmd_pub.publish(twist_msg)

        if state != self.last_sensor_state:
            self.get_logger().info(
                f"[{self.bot_id}] 센서(L:{l_val} R:{r_val}) -> {status} "
                f"[Linear: {twist_msg.twist.linear.x:.2f}, Angular: {twist_msg.twist.angular.z:.2f}]"
            )
            self.last_sensor_state = state


def main(args=None):
    rclpy.init(args=args)
    node = ReverseLineFollowerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node.is_tracing_active:
            stop_msg = TwistStamped()
            node.cmd_pub.publish(stop_msg)
        node.destroy_node()
        if rclpy.ok():
            try:
                rclpy.shutdown()
            except Exception:
                pass

if __name__ == '__main__':
    main()