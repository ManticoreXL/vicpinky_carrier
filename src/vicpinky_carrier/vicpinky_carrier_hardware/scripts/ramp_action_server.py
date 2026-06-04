import rclpy as rp
from rclpy.action import ActionServer
from rclpy.node import Node

from vicpinky_carrier_interfaces.action import RampControl
from vicpinky_carrier_hardware.ramp_driver import MirrorMotorControl

class RampControlServer(Node):
    def __init__(self):
        super().__init__("ramp_control_action_server")
        
        self._action_server = ActionServer(
            self,
            RampControl,
            "ramp_control",
            self.execute_callback
        )

    def execute_callback(self, goal_handle):
        return
    
def main(args=None):
    rp.init(args=args)
    ramp_control_action_server = RampControlServer()
    rp.spin(ramp_control_action_server)

if __name__ == "__main__":
    main()