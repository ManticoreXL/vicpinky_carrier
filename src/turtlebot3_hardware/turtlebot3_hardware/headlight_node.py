"""
SPI 기반 NeoPixel LED 제어용 노드
"""

import rclpy
from rclpy.node import Node
from rcl_interfaces.msg import SetParametersResult
from std_msgs.msg import String

import board
import neopixel_spi

class HeadlightNode(Node):
    """
    NeoPixel LED 하드웨어 제어 클래스
    """

    def __init__(self):
        """
        HeadlightNode 초기화
        """
        super().__init__('headlight_node')
        
        # Parameter 선언 (밝기 기본값을 100으로 변경)
        self.declare_parameter('led_count', 16)
        self.declare_parameter('led_brightness', 50)
        self.declare_parameter('blink_period', 0.5)
        self.declare_parameter('blink_count', 3)
        
        # 초기 Parameter 값 추출
        led_count = self.get_parameter('led_count').value
        # 0~100 범위의 입력값을 0.0~1.0 형태의 실수로 스케일링 변환
        self.current_brightness = self.get_parameter('led_brightness').value / 100.0
        
        blink_period = self.get_parameter('blink_period').value
        self.target_toggle_count = self.get_parameter('blink_count').value * 2
        
        # 하드웨어 스트립 초기화
        self.strip = neopixel_spi.NeoPixel_SPI(
            board.SPI(),
            led_count,
            brightness=self.current_brightness,
            pixel_order=neopixel_spi.GRB,
            auto_write=False
        )
        
        # 상태 변수
        self.current_state = False
        self.saved_state = False
        self.is_blinking = False
        self.toggle_count = 0
        
        self.color_on = (255, 255, 255)
        self.color_off = (0, 0, 0)
        
        # 초기 상태 적용 (소등)
        self.set_led_state(False)

        # 토픽 구독
        self.sub = self.create_subscription(
            String, 
            'headlight_cmd', 
            self.cmd_callback, 
            10
        )
        
        # Timer 생성
        self.timer = self.create_timer(blink_period, self.timer_callback)
        self.timer.cancel()

        # 파라미터 변경 감지 콜백 등록
        self.add_on_set_parameters_callback(self.parameters_callback)

        self.get_logger().info("Python Headlight Node Started (Brightness: 0-100%).")


    def parameters_callback(self, params):
        """
        파라미터 변경이 감지되면 호출되는 콜백 함수

        Args:
            params (list): 변경이 요청된 파라미터 객체 리슽

        Returns:
            SetParameterResult: 파라미터 변경 성공 여부와 결과 메시지
        """
        successful = True
        reason = "Parameters updated successfully"

        for param in params:
            if param.name == 'led_brightness':
                self.current_brightness = param.value / 100.0
                self.strip.brightness = self.current_brightness
                if self.current_state:
                    self.strip.show()
                self.get_logger().info(f"Parameter updated: led_brightness = {param.value}%")

            elif param.name == 'blink_period':
                was_running = not self.timer.is_canceled()
                self.timer.cancel()
                self.timer = self.create_timer(param.value, self.timer_callback)
                if not was_running:
                    self.timer.cancel()
                self.get_logger().info(f"Parameter updated: blink_period = {param.value}")

            elif param.name == 'blink_count':
                self.target_toggle_count = param.value * 2
                self.get_logger().info(f"Parameter updated: blink_count = {param.value}")

            elif param.name == 'led_count':
                successful = False
                reason = f"Hardware parameter '{param.name}' cannot be changed at runtime."
                self.get_logger().warn(reason)
                break

        return SetParametersResult(successful=successful, reason=reason)


    def set_led_state(self, state):
        """
        LED 점등 상태 변경

        Args:
            state (bool): True일 경우 color_on 색상으로 점등, False인 경우 소등
        """
        self.current_state = state
        color_to_set = self.color_on if state else self.color_off

        self.strip.fill(color_to_set)
        self.strip.show()


    def cmd_callback(self, msg):
        """
        headlight_cmd 토픽을 수신하면 호출되는 콜백 함수

        Args:
            msg (std_msgs.msg.String): 수신된 제어 메시지

        """
        cmd = msg.data.lower()

        if cmd == "on":
            self.is_blinking = False
            self.saved_state = True
            self.set_led_state(True)
            self.timer.cancel()

        elif cmd == "off":
            self.is_blinking = False
            self.saved_state = False
            self.set_led_state(False)
            self.timer.cancel()

        elif cmd == "blink":
            if not self.is_blinking:
                self.saved_state = self.current_state
                self.toggle_count = 0
                self.is_blinking = True
                self.timer.reset()


    def timer_callback(self):
        """
        점멸 모드가 활성화되었을 때 호출되는 타이머 콜백 함수
        """
        if self.is_blinking:
            if self.toggle_count < self.target_toggle_count:
                self.set_led_state(not self.current_state)
                self.toggle_count += 1
            else:
                self.set_led_state(self.saved_state)
                self.is_blinking = False
                self.timer.cancel()


def main(args=None):
    rclpy.init(args=args)
    node = HeadlightNode()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.set_led_state(False)
        node.strip.deinit()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()