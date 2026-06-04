import time
import rclpy
from rclpy.action import ActionServer
from rclpy.node import Node
from vicpinky_carrier_interfaces.action import RampControl

# TODO: 경사로 제어 액션 서버 구현

class RampActionServer(Node):
    def __init__(self):
        super().__init__("ramp_action_server")
        self._action_server = ActionServer(
            self,
            RampControl,
            "control_ramp",
            self.execute_callback    
        )
        self.get_logger().info("경사로 제어 액션 서버 실행됨")

    def execute_callback(self, goal_handle):
        # TODO: 액션 콜백 함수 구현
        return

def main(args=None):
    rclpy.init(args=args)
    ramp_action_server = RampActionServer()
    rclpy.spin(ramp_action_server)
    rclpy.shutdown()

if __name__ == "__main__":
    main()