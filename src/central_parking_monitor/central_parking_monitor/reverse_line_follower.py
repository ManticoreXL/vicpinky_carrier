#!/usr/bin/env python3
#
# 후진 구동 기반 라인트레이싱 및 자율 제어권 양보 노드 (적외선 센서 개조 버전)
# 개발: 김동석
#

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile
from gpiozero import DigitalInputDevice
from geometry_msgs.msg import TwistStamped
from std_msgs.msg import String

# 하드웨어 핀 매핑 (BCM 기준)
LEFT_PIN = 22
RIGHT_PIN = 24

class ReverseLineFollowerNode(Node):

    def __init__(self):
        super().__init__('reverse_line_follower_node')

        self.declare_parameter('bot_id', 'tb3_01')
        self.bot_id = self.get_parameter('bot_id').value

        qos = QoSProfile(depth=10)
        
        self.cmd_pub = self.create_publisher(TwistStamped, '/cmd_vel', qos)
        self.mode_sub = self.create_subscription(String, '/robot_mode', self._mode_cb, qos)
        
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

        self.get_logger().info(f"🚀 [{self.bot_id} 라인트레이서] 노드 가동. 외부 신호(LINE_TRACE) 대기 중...")

    def _mode_cb(self, msg):
        """ /robot_mode 신호에 따라 라인트레이싱 활성화 및 비활성화 처리 """
        if msg.data == "LINE_TRACE" and not self.is_tracing_active:
            self.is_tracing_active = True
            self.get_logger().warn(f"🟢 [{self.bot_id} 라인트레이서] LINE_TRACE 신호 수신! 라인트레이싱을 시작합니다.")

        elif msg.data != "LINE_TRACE" and self.is_tracing_active:
            # PARKING, PARKED, NAV 등 라인트레이스 이외의 신호 수신 시 작동 중지
            self.is_tracing_active = False
            self.get_logger().error(f"🛑 [{self.bot_id} 라인트레이서] {msg.data} 신호 수신. 제어권을 양보하고 대기 상태로 전환합니다.")
            
            # 제어권을 넘기기 전 관성 진행을 막기 위해 정지 명령 3회 발행
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