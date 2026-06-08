import rclpy
from rclpy.node import Node
from rcl_interfaces.msg import SetParametersResult
from std_msgs.msg import String
from rpi_ws281x import PixelStrip, Color

class HeadlightNode(Node):
    def __init__(self):
        super().__init__('headlight_node')
        
        # Parameter 선언 및 기본값 설정
        self.declare_parameter('led_count', 16)
        self.declare_parameter('led_pin', 12)
        self.declare_parameter('led_freq_hz', 800000)
        self.declare_parameter('led_dma', 10)
        self.declare_parameter('led_brightness', 255)
        self.declare_parameter('led_invert', False)
        self.declare_parameter('led_channel', 0)
        
        self.declare_parameter('blink_period', 0.5)
        self.declare_parameter('blink_count', 3)
        
        # 초기 Parameter 값 추출
        led_count = self.get_parameter('led_count').value
        led_pin = self.get_parameter('led_pin').value
        led_freq_hz = self.get_parameter('led_freq_hz').value
        led_dma = self.get_parameter('led_dma').value
        self.current_brightness = self.get_parameter('led_brightness').value
        led_invert = self.get_parameter('led_invert').value
        led_channel = self.get_parameter('led_channel').value
        
        blink_period = self.get_parameter('blink_period').value
        self.target_toggle_count = self.get_parameter('blink_count').value * 2
        
        # 하드웨어 스트립 초기화
        self.strip = PixelStrip(
            led_count, 
            led_pin, 
            led_freq_hz, 
            led_dma, 
            led_invert, 
            self.current_brightness, 
            led_channel
        )
        self.strip.begin()
        
        # 상태 변수
        self.current_state = False
        self.saved_state = False
        self.is_blinking = False
        self.toggle_count = 0
        self.color = Color(255, 255, 255)
        
        # 초기 상태 적용
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

        self.get_logger().info("Python Headlight Node Started with Dynamic Parameters.")


    def parameters_callback(self, params):
        successful = True
        reason = "Parameters updated successfully"

        for param in params:
            if param.name == 'led_brightness':
                self.current_brightness = param.value
                self.strip.setBrightness(self.current_brightness)
                # LED가 켜져 있는 상태라면 변경된 밝기를 즉시 하드웨어에 반영
                if self.current_state:
                    self.strip.show()
                self.get_logger().info(f"Parameter updated: led_brightness = {param.value}")

            elif param.name == 'blink_period':
                # 진행 중이던 Timer를 취소하고 새로운 주기로 Timer 재설정
                was_running = not self.timer.is_canceled()
                self.timer.cancel()
                self.timer = self.create_timer(param.value, self.timer_callback)
                if not was_running:
                    self.timer.cancel()
                self.get_logger().info(f"Parameter updated: blink_period = {param.value}")

            elif param.name == 'blink_count':
                self.target_toggle_count = param.value * 2
                self.get_logger().info(f"Parameter updated: blink_count = {param.value}")

            # 실행 중 변경이 불가능한 하드웨어 파라미터의 업데이트 요청 거부
            elif param.name in ['led_pin', 'led_count', 'led_freq_hz', 'led_dma', 'led_invert', 'led_channel']:
                successful = False
                reason = f"Hardware parameter '{param.name}' cannot be changed at runtime."
                self.get_logger().warn(reason)
                break

        return SetParametersResult(successful=successful, reason=reason)


    def set_led_state(self, state):
        self.current_state = state
        color_to_set = self.color if state else Color(0, 0, 0)

        for i in range(self.strip.numPixels()):
            self.strip.setPixelColor(i, color_to_set)

        self.strip.show()


    def cmd_callback(self, msg):
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
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()