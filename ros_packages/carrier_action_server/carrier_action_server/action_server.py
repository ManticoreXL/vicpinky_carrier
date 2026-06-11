#!/usr/bin/env python3
"""
Carrier Action Server
~~~~~~~~~~~~~~~~~~~~~
범용 운반 로봇 Action Server.  rosbridge 를 통해 웹 프론트에서 goal 을 수신하고
진행 상황(feedback)과 최종 결과(result)를 반환한다.

실행:
  ros2 run carrier_action_server action_server --ros-args -p robot_id:=bigpinky
"""

import time
import threading
import rclpy
from rclpy.node import Node
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.action.server import ServerGoalHandle
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor

from carrier_msgs.action import CarrierTask


class CarrierActionServer(Node):
    def __init__(self):
        super().__init__("carrier_action_server")

        self.declare_parameter("robot_id", "robot")
        self._robot_id: str = self.get_parameter("robot_id").value  # type: ignore

        self._cb_group = ReentrantCallbackGroup()

        self._action_server = ActionServer(
            self,
            CarrierTask,
            f"/{self._robot_id}/carrier_task",
            execute_callback=self._execute,
            goal_callback=self._goal_callback,
            cancel_callback=self._cancel_callback,
            callback_group=self._cb_group,
        )

        self.get_logger().info(
            f"CarrierActionServer 시작 — /{self._robot_id}/carrier_task"
        )

    # ── Goal / Cancel 수락 정책 ──────────────────────────────────────────────

    def _goal_callback(self, goal_request: CarrierTask.Goal) -> GoalResponse:
        self.get_logger().info(
            f"Goal 수신: task={goal_request.task_type}, target={goal_request.target_id}"
        )
        return GoalResponse.ACCEPT

    def _cancel_callback(self, goal_handle: ServerGoalHandle) -> CancelResponse:
        self.get_logger().info("Cancel 요청 수신")
        return CancelResponse.ACCEPT

    # ── 실행 로직 ────────────────────────────────────────────────────────────

    def _execute(self, goal_handle: ServerGoalHandle) -> CarrierTask.Result:
        goal: CarrierTask.Goal = goal_handle.request
        self.get_logger().info(
            f"Task 실행: {goal.task_type} → {goal.target_id}"
        )

        result = CarrierTask.Result()
        feedback = CarrierTask.Feedback()
        start_time = time.time()

        # ── 시뮬레이션 진행 (실제 로봇은 여기서 nav2 / 하드웨어 제어) ─────────
        total_steps = 10
        simulated_distance = 5.0  # meters

        for step in range(total_steps + 1):
            # Cancel 확인
            if goal_handle.is_cancel_requested:
                result.success = False
                result.message = "취소됨"
                result.elapsed_sec = float(time.time() - start_time)
                goal_handle.canceled()
                self.get_logger().info("Goal 취소됨")
                return result

            progress = step / total_steps
            feedback.progress = progress
            feedback.distance_remaining = simulated_distance * (1.0 - progress)
            feedback.status = (
                f"{goal.task_type} 진행 중 — {goal.target_id} "
                f"({int(progress * 100)}%)"
            )
            goal_handle.publish_feedback(feedback)
            self.get_logger().debug(f"Feedback: {feedback.status}")

            time.sleep(0.5)  # 실제 로봇에서는 제거하고 상태 폴링으로 교체

        elapsed = float(time.time() - start_time)
        result.success = True
        result.message = f"{goal.task_type} 완료: {goal.target_id}"
        result.elapsed_sec = elapsed

        goal_handle.succeed()
        self.get_logger().info(f"Goal 완료 ({elapsed:.1f}s)")
        return result


def main(args=None):
    rclpy.init(args=args)
    node = CarrierActionServer()
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
