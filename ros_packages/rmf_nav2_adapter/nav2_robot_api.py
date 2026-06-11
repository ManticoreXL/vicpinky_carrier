#!/usr/bin/env python3
"""
Nav2용 RobotAPI — open-rmf/fleet_adapter_template 의 RobotClientAPI.py 를 대체.

템플릿은 로봇이 REST API를 가진다고 가정하지만, 우리 로봇은 Nav2로 움직이므로
ROS2(NavigateToPose 액션 + tf 위치 + battery)로 구현한다.

핵심 메서드 (EasyFullControl 어댑터가 호출):
  position(robot_name)              -> [x, y, theta] (로봇 map 프레임, m/rad)
  navigate(robot_name, pose, ...)   -> NavigateToPose goal 전송
  stop(robot_name)                  -> goal 취소
  navigation_completed(robot_name)  -> 도착 여부
  battery_soc(robot_name)           -> 0.0~1.0

좌표는 "로봇 map 프레임" 기준. RMF↔로봇 좌표 변환은 config.yaml 의
reference_coordinates 로 어댑터가 처리하므로 여기선 로봇 좌표만 다룬다.
"""
import math
import time

from rclpy.action import ActionClient
from rclpy.duration import Duration

from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import BatteryState
from nav2_msgs.action import NavigateToPose

import tf2_ros


class RobotAPI:
    def __init__(self, node, config_yaml=None):
        """
        node: rclpy Node (fleet_adapter.py가 만들어 넘겨줌)
        config_yaml: 템플릿 config (네임스페이스/프레임 등 읽기)
        """
        self.node = node
        cfg = config_yaml or {}

        # 토픽/프레임 설정 (네임스페이스 로봇이면 여기 바꿈)
        self.nav_action   = cfg.get("nav_action", "/navigate_to_pose")
        self.map_frame     = cfg.get("map_frame", "map")
        self.base_frame    = cfg.get("base_frame", "base_footprint")
        self.battery_topic = cfg.get("battery_topic", "/battery_state")

        # NavigateToPose 액션 클라이언트
        self._nav_client = ActionClient(node, NavigateToPose, self.nav_action)

        # tf 로 로봇 위치 조회
        self._tf_buffer = tf2_ros.Buffer()
        self._tf_listener = tf2_ros.TransformListener(self._tf_buffer, node)

        # 배터리
        self._battery = 1.0
        node.create_subscription(
            BatteryState, self.battery_topic, self._on_battery, 10)

        # 진행 중 goal 추적
        self._goal_handle = None
        self._nav_done = True

    # ── 콜백 ──────────────────────────────────────────────────────────────
    def _on_battery(self, msg: BatteryState):
        if msg.percentage is not None and not math.isnan(msg.percentage):
            self._battery = msg.percentage if msg.percentage <= 1.0 else msg.percentage / 100.0

    # ── EasyFullControl 인터페이스 ────────────────────────────────────────

    def check_connection(self) -> bool:
        """Nav2 액션 서버 살아있는지."""
        return self._nav_client.server_is_ready() or \
            self._nav_client.wait_for_server(timeout_sec=1.0)

    def position(self, robot_name=None):
        """로봇 현재 [x, y, theta] (map 프레임). 없으면 None."""
        try:
            t = self._tf_buffer.lookup_transform(
                self.map_frame, self.base_frame, rclpy.time.Time())
            q = t.transform.rotation
            yaw = math.atan2(2 * (q.w * q.z + q.x * q.y),
                             1 - 2 * (q.y * q.y + q.z * q.z))
            return [t.transform.translation.x, t.transform.translation.y, yaw]
        except Exception:
            return None

    def navigate(self, robot_name, pose, map_name=None, speed_limit=0.0) -> bool:
        """pose=[x, y, theta] (로봇 map 프레임)로 NavigateToPose 전송."""
        if not self._nav_client.wait_for_server(timeout_sec=2.0):
            self.node.get_logger().warn("Nav2 액션 서버 없음")
            return False

        goal = NavigateToPose.Goal()
        ps = PoseStamped()
        ps.header.frame_id = self.map_frame
        ps.header.stamp = self.node.get_clock().now().to_msg()
        ps.pose.position.x = float(pose[0])
        ps.pose.position.y = float(pose[1])
        yaw = float(pose[2])
        ps.pose.orientation.z = math.sin(yaw / 2.0)
        ps.pose.orientation.w = math.cos(yaw / 2.0)
        goal.pose = ps

        self._nav_done = False
        send_future = self._nav_client.send_goal_async(goal)
        send_future.add_done_callback(self._on_goal_response)
        self.node.get_logger().info(
            f"navigate → ({pose[0]:.2f}, {pose[1]:.2f}, {yaw:.2f})")
        return True

    def _on_goal_response(self, future):
        gh = future.result()
        if not gh.accepted:
            self.node.get_logger().warn("Nav2 goal 거부됨")
            self._nav_done = True
            return
        self._goal_handle = gh
        gh.get_result_async().add_done_callback(self._on_result)

    def _on_result(self, future):
        self._nav_done = True
        self._goal_handle = None

    def stop(self, robot_name=None) -> bool:
        if self._goal_handle is not None:
            self._goal_handle.cancel_goal_async()
            self._goal_handle = None
        self._nav_done = True
        return True

    def navigation_remaining_duration(self, robot_name=None) -> float:
        # 간단화: 완료면 0, 아니면 대략값. (정밀화하려면 feedback 사용)
        return 0.0 if self._nav_done else 1.0

    def navigation_completed(self, robot_name=None) -> bool:
        return self._nav_done

    def battery_soc(self, robot_name=None):
        return self._battery

    def requires_replan(self, robot_name=None) -> bool:
        return False

    # 커스텀 액션(도킹/램프 등)은 여기서 start_activity 로 확장
    def start_activity(self, robot_name, activity, label):
        self.node.get_logger().info(f"start_activity: {activity}/{label} (미구현)")
        return False


# rclpy.time import (position에서 사용)
import rclpy.time  # noqa: E402
