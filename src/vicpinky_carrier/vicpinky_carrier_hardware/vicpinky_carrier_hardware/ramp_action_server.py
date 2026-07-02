#!/usr/bin/env python3
import rclpy as rp
from rclpy.action import ActionServer
from rclpy.node import Node
from rclpy.executors import MultiThreadedExecutor
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
# from std_msgs.msg import String
import time

from sensor_msgs.msg import JointState
from std_msgs.msg import Header
from vicpinky_carrier_interfaces.action import RampControl
from vicpinky_carrier_interfaces.msg import RampState
from vicpinky_carrier_hardware.ramp_driver import MirrorMotorControl

# ros2 action send_goal /ramp_control vicpinky_carrier_interfaces/action/RampControl "{target_string: 'Open'}"

class RampControlServer(Node):
    def __init__(self):
        super().__init__("ramp_controller")

        self.current_ramp_state = 'Closed'
        self.current_angle = 2020
        self.current_load = 0
        self.is_moving = False

        self.timer_cb_group = MutuallyExclusiveCallbackGroup()
        self.action_cb_group = MutuallyExclusiveCallbackGroup()

        self.joint_publisher = self.create_publisher(
            JointState, 'joint_states', 10
        )

        self.state_publisher = self.create_publisher(
            RampState, 'ramp_state', 10
        )

        self.timer = self.create_timer(0.1, self.timer_callback, callback_group=self.timer_cb_group)
        
        self._action_server = ActionServer(
            self, RampControl,
            "ramp_control", self.execute_callback, callback_group=self.action_cb_group
        )

        self.motor=MirrorMotorControl('/dev/open_rb_ramp',12,13)
        self.motor.set_profile_acc(3)
        self.motor.set_profile_vel(50)

    def timer_callback(self):
        # 타이머 콜백 함수
        # 상태 퍼블리시
        self.publish_state()
        self.publish_joint()

        # 경사로 상태 업데이트
        try:
            if self.is_moving:
                # 모터 과부화 확인 및 재부팅 블록
                l_over = self.motor.motor_overload_check(0)
                r_over = self.motor.motor_overload_check(1)
                if l_over or r_over:
                    self.motor.set_angle(self.current_angle)
                    if l_over: self.motor.reboot(0)
                    if r_over: self.motor.reboot(1)
                    time.sleep(1)
                    self.motor.set_torque()
                    time.sleep(0.5)
                    self.motor.set_profile_acc(3)
                    self.motor.set_profile_vel(50)
                    self.motor.set_angle(self.goal_angle)
                # 기존 코드
                self.current_angle , _ = self.motor.read_angle()
                self.current_load ,_ = self.motor.read_load()
                if self.motor.is_moving() or abs(self.goal_angle - self.current_angle) > 50:
                    pass
                else:
                    self.is_moving = False
                    self.current_ramp_state = 'Closed' if (self.goal_angle == 2048 or self.current_angle < 2700) else 'Open'
        except Exception as e:
            self.get_logger().error(f"Error while checking motor status: {e}")


    def publish_state(self):
        msg = RampState()
        msg.ramp_state = self.current_ramp_state
        msg.ramp_angle = float(self.current_angle)
        self.state_publisher.publish(msg)

    def publish_joint(self):
        msg = JointState()
        msg.header = Header()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = ['ramp_holder_joint_l']
        msg.position= [(self.current_angle - 2048) * 2 * 3.141592 / 4096]
        msg.velocity = []
        msg.effort = []
        self.joint_publisher.publish(msg)

    def execute_callback(self, goal_handle):
        # 액션 요청시 실행하는 함수
        result = RampControl.Result()
        goal_state=goal_handle.request.target_string

        # 입력값에 따른 실행 구분
        if goal_state in ['Open', 'open', 'o', 'opened', 'O', 'OPEN']:
            self.goal_angle = 3328
            self.get_logger().info("Opening the ramp!")
        elif goal_state in ['close', 'Close', 'c', 'closed', 'C', 'CLOSE']:
            self.goal_angle = 2020
            self.current_ramp_state = 'Closed'
            self.get_logger().info("Closing the ramp!")
        else:
            self.get_logger().info("Invalid command. Please enter [O]pen / [C]lose.")
            result.success = False
            result.final_state = self.current_ramp_state
            result.final_angle = self.current_angle
            goal_handle.abort()
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
            if self.current_load > 100:
                load_count = load_count + 1
                if load_count > 7 :
                    self.get_logger().info("Motor overload. Stop motor.")
                    target_angle = self.current_angle
                    self.goal_angle = target_angle-int(self.current_load/2)
                    self.motor.set_angle(self.goal_angle)
                    load_count = 0
            else:
                load_count = 0

            goal_handle.publish_feedback(feedback_msg)

        goal_handle.succeed()
        result.success = True
        result.final_state = self.current_ramp_state
        result.final_angle = self.current_angle
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