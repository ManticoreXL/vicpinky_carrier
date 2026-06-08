import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from rpi_ws281x import PixelStrip, Color

# LED 초기 설정값
LED_COUNT = 16        # LED 개수
LED_PIN = 18          # GPIO 핀 (반드시 18, 12, 10 중 하나)
LED_FREQ_HZ = 800000  # 통신 주파수
LED_DMA = 10          # DMA 채널
LED_BRIGHTNESS = 255  # 밝기 (0~255)
LED_INVERT = False    # 신호 반전 여부
LED_CHANNEL = 0

class HeadlightNode(Node):
    def __init__(self):
        super().__init__('headlight_node')
        
        # 하드웨어 스트립 초기화
        self.strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
        self.strip.begin()
        
        # 상태 변수
        self.current_state = False
        self.saved_state = False
        self.is_blinking = False
        self.toggle_count = 0
        self.color = Color(255, 255, 255) # 흰색
        
        # 초기 상태(끄기) 적용
        self.set_led_state(False)

        # 토픽 구독
        self.sub = self.create_subscription(String, '/turtlebot/headlight_cmd', self.cmd_callback, 10)
        
        # 0.3초 주기 타이머
        self.timer = self.create_timer(0.3, self.timer_callback)
        self.get_logger().info("Python Headlight Node Started.")

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
        elif cmd == "off":
            self.is_blinking = False
            self.saved_state = False
            self.set_led_state(False)
        elif cmd == "blink":
            if not self.is_blinking:
                self.saved_state = self.current_state
                self.toggle_count = 0
                self.is_blinking = True

    def timer_callback(self):
        if self.is_blinking:
            if self.toggle_count < 3:
                # 상태 반전
                self.set_led_state(not self.current_state)
                self.toggle_count += 1
            else:
                # 3번 깜빡임 종료 후 보존된 상태로 복구
                self.set_led_state(self.saved_state)
                self.is_blinking = False

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