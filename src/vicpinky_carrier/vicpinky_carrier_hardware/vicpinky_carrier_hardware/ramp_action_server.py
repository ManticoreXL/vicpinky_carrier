#!/usr/bin/env python3
import rclpy as rp
from rclpy.action import ActionServer
from rclpy.node import Node
from rclpy.executors import MultiThreadedExecutor
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
# from std_msgs.msg import String
import time

from vicpinky_carrier_interfaces.action import RampControl
from vicpinky_carrier_interfaces.msg import RampState
from vicpinky_carrier_hardware.ramp_driver import MirrorMotorControl

# ros2 action send_goal /ramp_control vicpinky_carrier_interfaces/action/RampControl "{target_string: 'Open'}"

class RampControlServer(Node):
    def __init__(self):
        super().__init__("ramp_controller")

        self.current_ramp_state = 'Closed'
        self.current_angle = 2048
        self.current_load = 0
        self.is_moving = False

        self.timer_cb_group = MutuallyExclusiveCallbackGroup()
        self.action_cb_group = MutuallyExclusiveCallbackGroup()

        self.state_publisher = self.create_publisher(
            RampState, 'ramp_state', 10
        )

        self.timer = self.create_timer(0.1, self.timer_callback, callback_group=self.timer_cb_group)
        
        self._action_server = ActionServer(
            self, RampControl,
            "ramp_control", self.execute_callback, callback_group=self.action_cb_group
        )

        self.motor=MirrorMotorControl('/dev/open_rb_ramp',12,13)
        self.motor.set_profile_vel(30)

    def timer_callback(self):
        # 타이머 콜백 함수
        # 상태 퍼블리시
        self.publish_state()

        # 경사로 상태 업데이트
        try:
            if self.is_moving:
                self.current_angle , _ = self.motor.read_angle()
                self.current_load ,_ = self.motor.read_load()
                if self.motor.is_moving() or abs(self.goal_angle - self.motor.read_angle()[0]) > 50:
                    pass
                else:
                    self.is_moving = False
                    self.current_ramp_state = 'Closed' if (self.goal_angle == 2048 or self.current_angle < 2700) else 'Open'
        except Exception as e:
            self.get_logger().error(f"Error while checking motor status: {e}")


    def publish_state(self):
        msg = RampState()
        msg.ramp_state = self.current_ramp_state
        msg.ramp_angle = self.current_angle * 360 /4096
        self.state_publisher.publish(msg)

    def execute_callback(self, goal_handle):
        # 액션 요청시 실행하는 함수
        result= RampControl.Result()
        goal_state=goal_handle.request.target_string

        # 입력값에 따른 실행 구분
        if goal_state in ['Open', 'open', 'o', 'opened', 'O', 'OPEN']:
            self.goal_angle = 3328
            self.get_logger().info("Opening the ramp!")
        elif goal_state in ['close', 'Close', 'c', 'closed', 'C', 'CLOSE']:
            self.goal_angle = 2048
            self.current_ramp_state = 'Closed'
            self.get_logger().info("Closing the ramp!")
        else:
            self.get_logger().info("Invalid command. Please enter [O]pen / [C]lose.")
            result.success = False
            result.final_state = self.current_ramp_state
            result.final_angle, _ = self.motor.read_angle()
            goal_handle.succeed()
            return result
        
        feedback_msg = RampControl.Feedback()
        load_count = 0
        self.motor.set_angle(self.goal_angle)
        self.is_moving = True

        # 액션 수행중
        while self.is_moving:
            time.sleep(0.05) 
            feedback_msg.current_angle = self.current_angle
            feedback_msg.current_load = self.current_load
            if self.current_load > 80:
                load_count = load_count + 1
                if load_count > 7 :
                    self.get_logger().info("Motor overload. Stop motor.")
                    target_angle = self.current_angle
                    self.goal_angle = target_angle-self.current_load
                    self.motor.set_angle(self.goal_angle)
                    load_count = 0
            else:
                load_count = 0

            goal_handle.publish_feedback(feedback_msg)

        goal_handle.succeed()
        result.success = True
        result.final_state = self.current_ramp_state
        result.final_angle, _ = self.motor.read_angle()
        self.get_logger().info(f"Ramp control action succeeded. Final state: {result.final_state}")
        return result
    
def main(args=None):
    rp.init(args=args)
    executor = MultiThreadedExecutor()
    ac = RampControlServer()
    executor.add_node(ac)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        ac.motor.close()
        ac.destroy_node()
        rp.shutdown()

if __name__ == "__main__":
    main()