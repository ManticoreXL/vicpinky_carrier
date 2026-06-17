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

        qos = QoSProfile(depth=10)
        
        # 속도 발행 및 관제 인터페이스 서브스크라이버 등록
        self.cmd_pub = self.create_publisher(TwistStamped, '/cmd_vel', qos)
        self.mode_sub = self.create_subscription(String, '/robot_mode', self._mode_cb, qos)
        
        # [개조] 카메라 구독 제거 및 GPIO 디지털 적외선 센서 객체 생성
        self.left_sensor = DigitalInputDevice(LEFT_PIN, pull_up=False)
        self.right_sensor = DigitalInputDevice(RIGHT_PIN, pull_up=False)
        
        self.is_parking_mode = False  
        
        # 🛠️ 속도 파라미터 수정 (0.06 -> 0.03으로 감속)
        self.linear_speed = 0.03       # 일반 직진 후진 속도
        self.turn_linear = 0.03        # 코너링 시 후진 속도
        self.base_turn_angular = 0.08
        self.max_turn_angular = 0.25
        self.turn_step = 0.04

        # 🔄 [부호 수정] 후진 주행 시 반대로 돌던 조향 부호 전면 반전
        self.LEFT_TURN_SIGN = +1   # 왼쪽 센서 감지 -> 좌회전 보정 (angular.z > 0, 후면 우측 이동)
        self.RIGHT_TURN_SIGN = -1  # 오른쪽 센서 감지 -> 우회전 보정 (angular.z < 0, 후면 좌측 이동)

        self.current_turn_angular = 0.0
        self.last_sensor_state = (None, None)

        # 이미지 콜백 대신 0.05초 주기(20Hz)로 센서를 감시할 타이머 구동
        self.timer_period = 0.05
        self.timer = self.create_timer(self.timer_period, self.control_loop)

        self.get_logger().info("🚀 [라인트레이서] 적외선 2선식 후진 기어 가동 완료. (속도: 0.03 저속 모드)")

    def _mode_cb(self, msg):
        """ 주차 관제 노드의 robot_mode(LINE_TRACE / PARKING / PARKED)에 따라
            제어권을 양보하거나 회수하는 콜백 """
        if msg.data in ("PARKING", "PARKED") and not self.is_parking_mode:
            self.is_parking_mode = True
            self.get_logger().error("🛑 [라인트레이서] 마커 락온 신호 수신! 제어권을 양보하고 구동을 정지합니다.")
            
            # 충돌 레이턴시를 방지하기 위한 브레이크 명령 즉시 3회 연속 발행
            for _ in range(3):
                stop_msg = TwistStamped()
                stop_msg.header.stamp = self.get_clock().now().to_msg()
                stop_msg.header.frame_id = 'base_link'
                stop_msg.twist.linear.x = 0.0
                stop_msg.twist.angular.z = 0.0
                self.cmd_pub.publish(stop_msg)

        elif msg.data == "LINE_TRACE" and self.is_parking_mode:
            # 정밀 주차 도중 타깃 마커를 일시적으로 놓쳐 관제 노드가
            # 라인트레이싱 모드로 복귀시킨 경우 -> 제어권을 다시 회수
            self.is_parking_mode = False
            self.get_logger().warn("🟢 [라인트레이서] 관제 노드 복귀 신호 수신! 라인트레이싱을 재개합니다.")

    def control_loop(self):
        # 주차 노드가 작동을 시작했다면 라인트레이싱 명령을 발행하지 않고 대기
        if self.is_parking_mode:
            return

        l_val = self.left_sensor.value
        r_val = self.right_sensor.value
        state = (l_val, r_val)

        twist_msg = TwistStamped()
        twist_msg.header.stamp = self.get_clock().now().to_msg()
        twist_msg.header.frame_id = 'base_link'

        # 1. 두꺼운 라인 정중앙 주행 또는 검은 바닥 안착 [1, 1]
        if state == (1, 1):
            twist_msg.twist.linear.x = -self.linear_speed  # 후진 직진 (-0.03)
            twist_msg.twist.angular.z = 0.0
            self.current_turn_angular = 0.0
            status = "⬇️ 후진 직진 (정중앙 주행 / 검은 바닥 안착)"

        # 2. 왼쪽 센서만 라인 감지 [1, 0] -> 반대 방향인 좌회전 보정으로 수정
        elif state == (1, 0):
            target_sign = self.LEFT_TURN_SIGN
            if self.current_turn_angular * target_sign <= 0:
                self.current_turn_angular = self.base_turn_angular * target_sign
            else:
                self.current_turn_angular += self.turn_step * target_sign
                if abs(self.current_turn_angular) > self.max_turn_angular:
                    self.current_turn_angular = self.max_turn_angular * target_sign
            
            twist_msg.twist.linear.x = -self.turn_linear  # 코너링 후진 (-0.03)
            twist_msg.twist.angular.z = self.current_turn_angular
            status = f"🔄 좌회전 보정 (후면 우측 이동, angular={self.current_turn_angular:.2f})"

        # 3. 오른쪽 센서만 라인 감지 [0, 1] -> 반대 방향인 우회전 보정으로 수정
        elif state == (0, 1):
            target_sign = self.RIGHT_TURN_SIGN
            if self.current_turn_angular * target_sign <= 0:
                self.current_turn_angular = self.base_turn_angular * target_sign
            else:
                self.current_turn_angular += self.turn_step * target_sign
                if abs(self.current_turn_angular) > self.max_turn_angular:
                    self.current_turn_angular = self.max_turn_angular * target_sign
            
            twist_msg.twist.linear.x = -self.turn_linear  # 코너링 후진 (-0.03)
            twist_msg.twist.angular.z = self.current_turn_angular
            status = f"🔄 우회전 보정 (후면 좌측 이동, angular={self.current_turn_angular:.2f})"

        # 4. 흰색 영역 또는 아루코 마커 흰색 여백 진입 [0, 0]
        elif state == (0, 0):
            twist_msg.twist.linear.x = -self.linear_speed  # 수색 후진 (-0.03)
            twist_msg.twist.angular.z = 0.0
            self.current_turn_angular = 0.0
            status = "⬜ 흰색 영역 감지 (PC 신호 대기하며 후진 유지)"

        else:
            twist_msg.twist.linear.x = 0.0
            twist_msg.twist.angular.z = 0.0
            status = "⚠️ 예외 상태 - 정지"

        # 최종 모터 명령 발행
        self.cmd_pub.publish(twist_msg)

        # 로그 출력 (상태 변화 시에만)
        if state != self.last_sensor_state:
            self.get_logger().info(
                f"센서(L:{l_val} R:{r_val}) -> {status} "
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
        # 종료 시 안전하게 정지 명령 전송
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