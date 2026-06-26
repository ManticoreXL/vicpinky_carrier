#!/usr/bin/env python3
#
# 후진 구동 기반 라인트레이싱 노드 (서비스 서버 버전, 적외선 센서 개조)
#
# 동작:
#   /line_trace (turtlebot_state_msgs/srv/LineTrace) 호출을 받으면
#   요청한 시간(duration)만큼 후진 라인트레이싱을 수행한 뒤 정지하고,
#   완료 결과를 응답으로 돌려준다(호출이 끝나면 = 수행 완료).
#
#   duration 이 0 이하이면 노드 파라미터 기본값(default_time)을 사용한다.
#   기본 시간은 실행 인자(-p default_time)로 조절 가능하다.
#
# 참고: 이전 버전의 /robot_state(TRACE) 구독·상태 연동은 제거하고,
#       외부 호출로 동작하는 단순 서비스로 재편했다.
#       (선을 따라 빅핑키 위로 올라가는 완료 판단은 빅핑키 카메라가 하므로
#        이 노드는 자체 완료 판단 없이 '지정 시간 수행'만 한다.)

import time

import rclpy
from rclpy.node import Node
from gpiozero import DigitalInputDevice
from geometry_msgs.msg import TwistStamped

from turtlebot_state_msgs.srv import LineTrace

# 하드웨어 핀 매핑 (BCM 기준)
LEFT_PIN = 22
RIGHT_PIN = 24


class ReverseLineFollowerNode(Node):

    def __init__(self):
        super().__init__('reverse_line_follower_node')

        # ── 파라미터 ──
        self.declare_parameter('bot_id', 'tb3_01')
        self.declare_parameter('default_time', 30.0)     # s 기본값 (실행 인자로 조절)
        self.declare_parameter('control_rate_hz', 20.0)
        self.bot_id = self.get_parameter('bot_id').value
        self.def_time = float(self.get_parameter('default_time').value)
        self.rate_hz = float(self.get_parameter('control_rate_hz').value)

        # cmd_vel — 브링업이 네임스페이스 없이 /cmd_vel 을 구독하므로 그대로 발행.
        # (로봇 구분은 ROS_DOMAIN_ID 로 함)
        self.cmd_pub = self.create_publisher(TwistStamped, '/cmd_vel', 10)

        # ── 적외선 센서 ──
        self.left_sensor = DigitalInputDevice(LEFT_PIN, pull_up=False)
        self.right_sensor = DigitalInputDevice(RIGHT_PIN, pull_up=False)

        # ── 주행 파라미터 (상수) ──
        self.linear_speed = 0.03
        self.turn_linear = 0.03
        self.base_turn_angular = 0.08
        self.max_turn_angular = 0.25
        self.turn_step = 0.04

        self.LEFT_TURN_SIGN = +1
        self.RIGHT_TURN_SIGN = -1

        self.current_turn_angular = 0.0
        self.last_sensor_state = (None, None)

        self._busy = False        # 동시 호출 방지

        # ── 서비스 ──
        self.srv = self.create_service(LineTrace, '/line_trace', self.on_line_trace)

        self.get_logger().info(
            f"🚀 [{self.bot_id} 라인트레이서] 서비스 대기. /line_trace 호출 시 수행 — "
            f"기본 시간={self.def_time:.1f}s")

    # ── 서비스 콜백: 요청한 시간만큼 라인트레이싱(완료될 때까지 블로킹) ──
    def on_line_trace(self, req, res):
        if self._busy:
            res.success = False
            res.traced_time = 0.0
            res.message = '이미 라인트레이싱 수행 중'
            self.get_logger().warn(f"⚠️ [{self.bot_id} 라인트레이서] 중복 호출 거부")
            return res

        duration = req.duration if req.duration > 0.0 else self.def_time

        self._busy = True
        # 호출마다 보정 상태 초기화
        self.current_turn_angular = 0.0
        self.last_sensor_state = (None, None)
        self.get_logger().warn(
            f"🟢 [{self.bot_id} 라인트레이서] 라인트레이싱 시작 — {duration:.1f}s")

        period = 1.0 / self.rate_hz if self.rate_hz > 0 else 0.05
        start = time.monotonic()
        try:
            while rclpy.ok():
                if time.monotonic() - start >= duration:
                    break
                self._step_once()
                time.sleep(period)
        finally:
            self._stop()
            self._busy = False

        traced = time.monotonic() - start
        res.success = True
        res.traced_time = float(traced)
        res.message = f'{traced:.1f}s 라인트레이싱 완료'
        self.get_logger().info(
            f"✅ [{self.bot_id} 라인트레이서] 수행 완료 ({traced:.1f}s)")
        return res

    # ── 한 주기: 센서 읽기 → 후진 라인트레이싱 cmd_vel 발행 ──
    def _step_once(self):
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
            status = "⬜ 흰색 영역 감지 (후진 유지)"

        else:
            twist_msg.twist.linear.x = 0.0
            twist_msg.twist.angular.z = 0.0
            status = "⚠️ 예외 상태 - 정지"

        self.cmd_pub.publish(twist_msg)

        if state != self.last_sensor_state:
            self.get_logger().info(
                f"[{self.bot_id}] 센서(L:{l_val} R:{r_val}) -> {status} "
                f"[Linear: {twist_msg.twist.linear.x:.2f}, "
                f"Angular: {twist_msg.twist.angular.z:.2f}]")
            self.last_sensor_state = state

    # ── 정지: 관성 진행 방지를 위해 정지 명령 3회 발행 ──
    def _stop(self):
        for _ in range(3):
            stop_msg = TwistStamped()
            stop_msg.header.stamp = self.get_clock().now().to_msg()
            stop_msg.header.frame_id = f'{self.bot_id}/base_link'
            stop_msg.twist.linear.x = 0.0
            stop_msg.twist.angular.z = 0.0
            self.cmd_pub.publish(stop_msg)


def main(args=None):
    rclpy.init(args=args)
    node = ReverseLineFollowerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            try:
                rclpy.shutdown()
            except Exception:
                pass


if __name__ == '__main__':
    main()