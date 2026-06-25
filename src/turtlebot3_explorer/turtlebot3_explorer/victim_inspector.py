#!/usr/bin/env python3
# =====================================================================
# victim_inspector.py  (데모 모드 전용 / mission_coordinator 없이 동작)
#
# 역할 (응시 정지 전용):
#   victim_mapper 가 /victim/candidate (사람 보임) 를 내면 현재 진행 중인
#   nav2 목표를 취소해 로봇을 그 자리에 세우고 응시. /victim/confirmed 또는
#   /victim/rejected 를 받으면 응시를 풀고, '취소했던 그 목표'를 nav2 에 다시
#   보냄(서버가 준 목표를 이어감).
#   ※ victim 회피(costmap 장애물)는 별도 노드 victim_obstacle_publisher 가 담당.
#      (실시간/데모 양쪽 공용). 이 노드는 응시 정지/재개만 책임진다.
#
# 전제:
#   - nav2 가 NavigateToPose 액션 서버(/navigate_to_pose)를 제공(navigation_launch).
#   - 서버(관제)는 목표를 /goal_pose (PoseStamped) 로 보냄. 그래야 이 노드가
#     기억했다가 응시 후 재전송할 수 있음.
#
# 토픽:
#   (구독) /victim/candidate  std_msgs/Empty
#          /victim/confirmed  geometry_msgs/PoseStamped
#          /victim/rejected   std_msgs/Empty
#          /goal_pose         geometry_msgs/PoseStamped (서버가 주는 목표; 표준 입력)
#   (액션) /navigate_to_pose  nav2_msgs/action/NavigateToPose (목표 전송/취소)
# =====================================================================
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient

from std_msgs.msg import Empty
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose


class VictimInspector(Node):
    IDLE = 'IDLE'
    NAVIGATING = 'NAVIGATING'
    INSPECTING = 'INSPECTING'

    def __init__(self):
        super().__init__('victim_inspector')

        # ---- 파라미터 ----
        self.declare_parameter('candidate_topic', '/victim/candidate')
        self.declare_parameter('confirmed_topic', '/victim/confirmed')
        self.declare_parameter('rejected_topic', '/victim/rejected')
        self.declare_parameter('goal_in_topic', '/goal_pose')          # 서버가 주는 목표
        self.declare_parameter('nav_action', '/navigate_to_pose')
        self.declare_parameter('map_frame', 'map')
        self.declare_parameter('inspect_timeout', 10.0)    # 확정/오탐 없을 때 자동 재개(초)

        g = self.get_parameter
        self.map_frame = g('map_frame').value
        self.goal_in_topic = g('goal_in_topic').value
        self.nav_action = g('nav_action').value
        self.inspect_timeout = float(g('inspect_timeout').value)

        # ---- 상태 ----
        self.state = self.IDLE
        self.current_goal = None       # 현재(또는 마지막으로 받은) 목표 PoseStamped
        self.inspect_start = None
        self._goal_handle = None       # 진행 중 nav2 목표 핸들
        self._suppress_result = False  # 응시로 취소한 목표의 결과 무시

        # ---- 액션 클라이언트 ----
        self._nav = ActionClient(self, NavigateToPose, self.nav_action)

        # ---- 구독 ----
        self.create_subscription(Empty, g('candidate_topic').value, self._on_candidate, 10)
        self.create_subscription(PoseStamped, g('confirmed_topic').value, self._on_confirmed, 10)
        self.create_subscription(Empty, g('rejected_topic').value, self._on_rejected, 10)
        self.create_subscription(PoseStamped, self.goal_in_topic, self._on_goal_in, 10)

        # ---- 타이머: 응시 타임아웃 점검 ----
        self.create_timer(0.5, self._tick)

        self.get_logger().info(
            f'victim_inspector(응시 전용) 시작. 목표입력={self.goal_in_topic}')

    # ==================================================================
    # 목표 입력 (서버 → /goal_pose)
    # ==================================================================
    def _on_goal_in(self, msg: PoseStamped):
        """ 서버가 준 목표를 기억하고 nav2 로 전송. """
        self.current_goal = msg
        if self.state == self.INSPECTING:
            # 응시 중엔 보류했다가 응시 끝나면 보냄
            self.get_logger().info('응시 중 새 목표 수신 → 보류(응시 후 전송).')
            return
        self._send_goal(msg)

    def _send_goal(self, pose: PoseStamped):
        if not self._nav.wait_for_server(timeout_sec=2.0):
            self.get_logger().warn('nav2 액션 서버 대기 실패 — 목표 전송 보류.')
            return
        goal = NavigateToPose.Goal()
        goal.pose = pose
        self.state = self.NAVIGATING
        self.get_logger().info(
            f'[목표 전송] ({pose.pose.position.x:.2f}, {pose.pose.position.y:.2f})')
        fut = self._nav.send_goal_async(goal)
        fut.add_done_callback(self._on_goal_response)

    def _on_goal_response(self, future):
        gh = future.result()
        if not gh.accepted:
            self.get_logger().warn('nav2 가 목표를 거부함.')
            self._goal_handle = None
            self.state = self.IDLE
            return
        self._goal_handle = gh
        rf = gh.get_result_async()
        rf.add_done_callback(self._on_goal_result)

    def _on_goal_result(self, future):
        self._goal_handle = None
        if self._suppress_result:
            # 응시로 취소한 목표의 결과 → 무시(재전송은 응시 해제에서)
            self._suppress_result = False
            return
        if self.state == self.NAVIGATING:
            self.state = self.IDLE
            self.get_logger().info('목표 도착(또는 종료).')

    # ==================================================================
    # 응시(멈춤)
    # ==================================================================
    def _on_candidate(self, msg):
        """ 사람 후보 감지 → 주행 중이면 목표 취소하고 응시. """
        if self.state != self.NAVIGATING or self._goal_handle is None:
            return
        self.get_logger().warn('● 사람 후보 감지 → 정지하고 응시 시작.')
        self.state = self.INSPECTING
        self.inspect_start = self.get_clock().now()
        self._suppress_result = True
        try:
            self._goal_handle.cancel_goal_async()
        except Exception as e:
            self.get_logger().warn(f'응시: 목표 취소 실패(무시): {e}')

    def _on_confirmed(self, msg: PoseStamped):
        if self.state != self.INSPECTING:
            return
        self.get_logger().warn(
            f'★ 조난자 확정 ({msg.pose.position.x:.2f}, {msg.pose.position.y:.2f}) '
            f'→ 응시 종료, 목표 재개.')
        self._resume_after_inspection()

    def _on_rejected(self, msg):
        if self.state != self.INSPECTING:
            return
        self.get_logger().info('오탐 판정 → 응시 종료, 목표 재개.')
        self._resume_after_inspection()

    def _resume_after_inspection(self):
        """ 응시 풀고, 기억해둔 목표를 다시 전송. victim 은 이미 costmap 에 장애물로
            올라가 있으므로 nav2 planner 가 알아서 우회 경로를 만든다. """
        self.inspect_start = None
        if self.current_goal is not None:
            self.get_logger().info('기억한 목표로 재전송(회피는 costmap 이 처리).')
            self._send_goal(self.current_goal)
        else:
            self.state = self.IDLE

    def _tick(self):
        """ 응시 타임아웃 안전장치(확정/오탐 신호 유실 시 자동 재개). """
        if self.state != self.INSPECTING or self.inspect_start is None:
            return
        waited = (self.get_clock().now() - self.inspect_start).nanoseconds / 1e9
        if waited > self.inspect_timeout:
            self.get_logger().warn(f'응시 {waited:.0f}s 경과 → 자동 재개.')
            self._resume_after_inspection()


def main():
    rclpy.init()
    node = VictimInspector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
