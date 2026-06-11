#!/usr/bin/env python3
"""
vicpinky_carrier - mission_coordinator

미션 흐름:
  INIT       : /map 과 TF(map->base) 가 준비될 때까지 대기, 준비되면 출발 위치를 home 으로 기록
  EXPLORING  : 프론티어(미지 영역 경계)를 찾아 가장 가까운 곳으로 자율 주행
  RETURNING  : 유효 프론티어가 0개가 되면(맵 완성) home 으로 복귀 (재시도 + 안전장치)
  DONE       : 맵을 저장하고 노드 종료

루프 방지:
  - EXPLORING: 한 목표에 max_goal_attempts 회 연속 실패하면 그 지점을 블랙리스트 처리하고 다른 곳 탐색
  - RETURNING: home 목표를 max_return_attempts 회까지 재시도, 그래도 못 가면 현 위치에서 맵 저장 후 종료
"""

import numpy as np

import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.qos import (
    QoSProfile,
    QoSReliabilityPolicy,
    QoSDurabilityPolicy,
    QoSHistoryPolicy,
)

from std_msgs.msg import Empty
from nav_msgs.msg import OccupancyGrid
from nav2_msgs.action import NavigateToPose
from action_msgs.msg import GoalStatus

import tf2_ros
from tf2_ros import TransformException

# slam_toolbox 맵 저장 서비스 (pgm + yaml 로 저장)
from slam_toolbox.srv import SaveMap


class ExplorationCoordinator(Node):
    # ---- 미션 상태 ----
    INIT = 'INIT'
    EXPLORING = 'EXPLORING'
    RETURNING = 'RETURNING'
    DONE = 'DONE'

    def __init__(self):
        super().__init__('mission_coordinator')

        # ---- 파라미터 (실행 시 -p 로 바꿀 수 있음) ----
        self.declare_parameter('map_save_path', '/home/USERNAME/maps/disaster_map')
        self.declare_parameter('min_frontier_size', 8)      # 이 셀 수 미만의 프론티어 덩어리는 노이즈로 무시
        self.declare_parameter('base_frame', 'base_footprint')
        self.declare_parameter('global_frame', 'map')
        self.declare_parameter('min_goal_distance', 0.5)    # Nav2 도착 허용오차보다 커야 함
        self.declare_parameter('obstacle_clearance', 0.25)  # 목표를 장애물에서 최소 이만큼 떨어진 곳에만 (m)
        self.declare_parameter('max_goal_attempts', 4)      # 한 목표에 이만큼 연속 실패하면 포기(블랙리스트)
        self.declare_parameter('blacklist_radius', 0.4)     # 블랙리스트 지점 반경 내 프론티어는 다시 안 고름 (m)
        self.declare_parameter('max_return_attempts', 5)    # home 복귀를 이만큼 재시도 후 안 되면 현 위치 저장
        # ---- 강건성(실물) 파라미터 ----
        self.declare_parameter('goal_retry_delay', 3.0)          # 실패 후 다음 시도까지 대기(초)
        self.declare_parameter('localization_timeout', 3.0)      # map->base TF가 이보다 오래되면 localization 미준비로 보고 대기(초)
        self.declare_parameter('localization_lost_timeout', 60.0)  # localization이 이만큼 안 돌아오면 미션 종료(초)
        self.declare_parameter('min_goal_runtime', 2.0)          # 골이 이보다 빨리 중단되면 '즉시 실패'(타이밍 문제)로 보고 블랙리스트 미집계(초)
        # ---- 온디맨드 마무리 ----
        self.declare_parameter('finish_topic', '/mission/finish_now')  # 이 토픽(std_msgs/Empty) 수신 시 현재 맵 저장 후 복귀

        self.map_save_path = self.get_parameter('map_save_path').value
        self.min_frontier_size = int(self.get_parameter('min_frontier_size').value)
        self.base_frame = self.get_parameter('base_frame').value
        self.global_frame = self.get_parameter('global_frame').value
        self.min_goal_distance = float(self.get_parameter('min_goal_distance').value)
        self.obstacle_clearance = float(self.get_parameter('obstacle_clearance').value)
        self.max_goal_attempts = int(self.get_parameter('max_goal_attempts').value)
        self.blacklist_radius = float(self.get_parameter('blacklist_radius').value)
        self.max_return_attempts = int(self.get_parameter('max_return_attempts').value)
        self.goal_retry_delay = float(self.get_parameter('goal_retry_delay').value)
        self.localization_timeout = float(self.get_parameter('localization_timeout').value)
        self.localization_lost_timeout = float(self.get_parameter('localization_lost_timeout').value)
        self.min_goal_runtime = float(self.get_parameter('min_goal_runtime').value)
        self.finish_topic = self.get_parameter('finish_topic').value

        # ---- 상태 변수 ----
        self.state = self.INIT
        self.current_map = None
        self.is_navigating = False
        self.home_pose = None        # 탐색 시작 시점의 로봇 위치 (x, y)
        self._finished = False       # True 가 되면 제어 루프에서 노드를 종료
        self._finish_requested = False   # 외부에서 '지금 마무리' 요청이 오면 True
        self._ignore_next_result = False # 마무리로 취소한 골의 결과를 한 번 무시
        self._goal_handle = None         # 현재 골 핸들 (취소용)

        # 루프 방지용 (탐색)
        self.current_goal = None     # 현재 추구 중인 목표 (x, y)
        self.fail_count = 0          # 현재 목표 연속 실패 횟수
        self.blacklist = []          # 반복 실패해 포기한 지점들 [(x, y), ...]

        # 복귀용
        self.return_attempts = 0

        # 강건성용 상태
        self._cooldown_until = None      # 이 시각까지는 새 골을 보내지 않음 (rclpy Time)
        self._goal_sent_time = None      # 마지막 골 전송 시각 (즉시실패 판정)
        self._last_loc_ok_time = None    # localization 이 마지막으로 신선했던 시각

        # 액션 퓨처 객체 (GC 방지용 클래스 변수)
        self.send_future = None
        self.result_future = None

        # ---- TF: 로봇의 현재 map 좌표를 얻기 위함 ----
        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        # ---- /map 구독 ----
        map_qos = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )
        self._map_sub = self.create_subscription(
            OccupancyGrid, 'map', self.map_callback, map_qos
        )

        # ---- Nav2 액션 클라이언트 ----
        self._nav_client = ActionClient(self, NavigateToPose, 'navigate_to_pose')

        # ---- 맵 저장 서비스 클라이언트 ----
        self._save_map_client = self.create_client(SaveMap, 'slam_toolbox/save_map')

        # ---- '지금 마무리' 트리거 구독 (부분 맵 저장 + 복귀) ----
        self._finish_sub = self.create_subscription(
            Empty, self.finish_topic, self._finish_now_callback, 10
        )

        # ---- 제어 루프(1Hz) ----
        self._control_timer = self.create_timer(1.0, self.control_loop)

        self.get_logger().info('mission_coordinator 초기화 완료. /map 과 TF 대기 중...')

    # ==================================================================
    # 콜백 / 제어 루프
    # ==================================================================
    def map_callback(self, msg):
        self.current_map = msg

    def control_loop(self):
        if self._finished:
            raise SystemExit   # 타이머 콜백에서 SystemExit → rclpy.spin() 탈출(권장 종료 패턴)

        # ---- '지금 마무리' 요청 처리 (주행 중이든 아니든 최우선) ----
        if self._finish_requested:
            if self.state == self.EXPLORING:
                self._begin_finish_now()
                return
            elif self.state in (self.RETURNING, self.DONE):
                # 이미 복귀/종료 중 → 중복 요청 무시
                self._finish_requested = False
            # INIT 이면 탐색이 시작될 때까지 요청을 보류(플래그 유지)

        # 주행 중이면 결과를 기다림 (콜백이 처리)
        if self.is_navigating:
            return

        now = self.get_clock().now()

        # 실패 후 쿨다운: 잠시 쉬었다가 다음 시도
        if self._cooldown_until is not None and now < self._cooldown_until:
            return

        if self.state == self.INIT:
            self._try_start()
            return

        # ---- localization 신선도 게이트 (EXPLORING/RETURNING 공통) ----
        if self.state in (self.EXPLORING, self.RETURNING):
            if self._localization_ready():
                self._last_loc_ok_time = now
            else:
                # map->base 가 오래됨 → 골을 쏘지 말고 대기 (스캔/TF 회복 대기)
                self.get_logger().warn(
                    'localization(map->base)이 오래되어 대기 중... (스캔/TF 회복 대기)',
                    throttle_duration_sec=3.0)
                if self._last_loc_ok_time is not None:
                    lost = (now - self._last_loc_ok_time).nanoseconds / 1e9
                    if lost > self.localization_lost_timeout:
                        self.get_logger().error(
                            f'localization {lost:.0f}s 동안 회복 안 됨 → 맵 저장 후 종료.')
                        self.save_map_and_finish()
                return

        if self.state == self.EXPLORING:
            self._explore_step()
        elif self.state == self.RETURNING:
            if self.return_attempts >= self.max_return_attempts:
                self.get_logger().warn(
                    f'복귀 {self.return_attempts}회 시도했으나 완주 실패. '
                    f'현재 위치에서 맵을 저장하고 종료합니다.')
                self.save_map_and_finish()
                return
            self._send_home_goal()

    def _set_cooldown(self):
        self._cooldown_until = self.get_clock().now() + Duration(seconds=self.goal_retry_delay)

    def _localization_ready(self):
        """ map->base TF 가 localization_timeout 이내로 신선하면 True """
        age = self._localization_age()
        return age is not None and age <= self.localization_timeout

    def _localization_age(self):
        """ 최신 map->base 변환의 나이(초). 없으면 None. """
        try:
            t = self.tf_buffer.lookup_transform(
                self.global_frame, self.base_frame, rclpy.time.Time())
        except TransformException:
            return None
        try:
            stamp = rclpy.time.Time.from_msg(t.header.stamp)
            return (self.get_clock().now() - stamp).nanoseconds / 1e9
        except Exception:
            return None

    def _try_start(self):
        """ 맵과 로봇 위치가 모두 준비되면 home 을 기록하고 탐색을 시작 """
        if self.current_map is None:
            return
        pose = self.get_robot_pose()
        if pose is None:
            self.get_logger().info('TF(map->base) 대기 중...', throttle_duration_sec=5.0)
            return
        self.home_pose = pose
        self.state = self.EXPLORING
        self._last_loc_ok_time = self.get_clock().now()
        self.get_logger().info(
            f'탐색 시작. 복귀 지점(home) = ({pose[0]:.2f}, {pose[1]:.2f})'
        )

    def _explore_step(self):
        """ 다음 프론티어로 이동. 유효 프론티어가 없으면 복귀 상태로 전환(전송은 control_loop) """
        goal = self.select_frontier_goal()
        if goal is None:
            self.get_logger().info('갈 수 있는 프론티어 없음 → 맵 작성 완료로 판단. 복귀 시작.')
            self.state = self.RETURNING
            self.return_attempts = 0
            return

        # 새 목표면 실패 카운터 리셋, 같은 목표 반복이면 유지(누적)
        if self.current_goal is None or not self._same_goal(goal, self.current_goal):
            self.current_goal = goal
            self.fail_count = 0

        self.send_nav_goal(goal[0], goal[1])

    # ==================================================================
    # 프론티어 탐지
    # ==================================================================
    def select_frontier_goal(self):
        """
        프론티어 중 (1) 로봇과 min_goal_distance 이상, (2) 장애물에서 obstacle_clearance 이상,
        (3) 블랙리스트 반경 밖인 가장 가까운 '셀' 좌표를 반환.
        (2)를 만족하는 후보가 없으면 거리/블랙리스트 조건만 만족하는 셀로 대체. 전혀 없으면 None.
        """
        grid = self.current_map
        info = grid.info
        w, h = info.width, info.height
        data = np.array(grid.data, dtype=np.int8).reshape((h, w))

        free = (data == 0)
        unknown = (data == -1)
        occupied = (data >= 50)

        frontier = np.zeros((h, w), dtype=bool)
        frontier[1:, :]  |= free[1:, :]  & unknown[:-1, :]
        frontier[:-1, :] |= free[:-1, :] & unknown[1:, :]
        frontier[:, 1:]  |= free[:, 1:]  & unknown[:, :-1]
        frontier[:, :-1] |= free[:, :-1] & unknown[:, 1:]

        clusters = self._cluster_frontiers(frontier, self.min_frontier_size)
        if not clusters:
            return None

        res = info.resolution
        ox = info.origin.position.x
        oy = info.origin.position.y

        clearance_cells = max(0, int(round(self.obstacle_clearance / res)))
        blocked = self._dilate(occupied, clearance_cells)

        robot = self.get_robot_pose()
        rx, ry = robot if robot is not None else (0.0, 0.0)
        min_d2 = self.min_goal_distance ** 2

        best_clear = None
        best_clear_d2 = None
        best_any = None
        best_any_d2 = None

        for cells in clusters:
            for (row, col) in cells:
                wx = ox + (col + 0.5) * res
                wy = oy + (row + 0.5) * res
                d2 = (wx - rx) ** 2 + (wy - ry) ** 2
                if d2 < min_d2:
                    continue
                if self._is_blacklisted(wx, wy):
                    continue

                if best_any_d2 is None or d2 < best_any_d2:
                    best_any_d2 = d2
                    best_any = (wx, wy)

                if not blocked[row, col]:
                    if best_clear_d2 is None or d2 < best_clear_d2:
                        best_clear_d2 = d2
                        best_clear = (wx, wy)

        return best_clear if best_clear is not None else best_any

    def _is_blacklisted(self, x, y):
        r2 = self.blacklist_radius ** 2
        for (bx, by) in self.blacklist:
            if (x - bx) ** 2 + (y - by) ** 2 < r2:
                return True
        return False

    @staticmethod
    def _same_goal(a, b, tol=0.2):
        return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < tol ** 2

    @staticmethod
    def _cluster_frontiers(frontier_mask, min_size):
        coords = np.argwhere(frontier_mask)
        remaining = set(map(tuple, coords.tolist()))
        neighbors = [(-1, -1), (-1, 0), (-1, 1),
                     (0, -1),           (0, 1),
                     (1, -1),  (1, 0),  (1, 1)]
        clusters = []
        while remaining:
            seed = remaining.pop()
            stack = [seed]
            cells = [seed]
            while stack:
                cr, cc = stack.pop()
                for dr, dc in neighbors:
                    nb = (cr + dr, cc + dc)
                    if nb in remaining:
                        remaining.discard(nb)
                        stack.append(nb)
                        cells.append(nb)
            if len(cells) >= min_size:
                clusters.append(cells)
        return clusters

    @staticmethod
    def _dilate(mask, iterations):
        out = mask.copy()
        for _ in range(iterations):
            d = out.copy()
            d[1:, :]   |= out[:-1, :]
            d[:-1, :]  |= out[1:, :]
            d[:, 1:]   |= out[:, :-1]
            d[:, :-1]  |= out[:, 1:]
            d[1:, 1:]   |= out[:-1, :-1]
            d[1:, :-1]  |= out[:-1, 1:]
            d[:-1, 1:]  |= out[1:, :-1]
            d[:-1, :-1] |= out[1:, 1:]
            out = d
        return out

    # ==================================================================
    # TF
    # ==================================================================
    def get_robot_pose(self):
        try:
            t = self.tf_buffer.lookup_transform(
                self.global_frame, self.base_frame, rclpy.time.Time()
            )
            return (t.transform.translation.x, t.transform.translation.y)
        except TransformException:
            return None

    # ==================================================================
    # Nav2 주행
    # ==================================================================
    def send_nav_goal(self, x, y):
        if not self._nav_client.wait_for_server(timeout_sec=5.0):
            self.get_logger().error('Nav2 액션 서버 응답 없음!')
            self.is_navigating = False
            return

        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = self.global_frame
        goal.pose.header.stamp = self.get_clock().now().to_msg()
        goal.pose.pose.position.x = float(x)
        goal.pose.pose.position.y = float(y)
        goal.pose.pose.orientation.w = 1.0

        self.is_navigating = True
        self._goal_sent_time = self.get_clock().now()
        self.get_logger().info(f'[{self.state}] 목표 전송 → ({x:.2f}, {y:.2f})')

        self.send_future = self._nav_client.send_goal_async(goal)
        self.send_future.add_done_callback(self.goal_response_callback)

    def goal_response_callback(self, future):
        handle = future.result()
        if not handle.accepted:
            self.get_logger().warn('Nav2 가 목표를 거부했습니다.')
            self.is_navigating = False
            self._goal_handle = None
            # 거부는 보통 일시적 → 즉시 실패로 보고 블랙리스트 미집계, 쿨다운 후 재시도(control_loop)
            if self.state == self.EXPLORING:
                self._register_failure(instant=True)
            self._set_cooldown()
            return

        self._goal_handle = handle
        self.result_future = handle.get_result_async()
        self.result_future.add_done_callback(self.get_result_callback)

    def get_result_callback(self, future):
        status = future.result().status
        self.is_navigating = False
        self._goal_handle = None

        # 마무리 요청으로 취소한 탐색 골의 결과 → 한 번 무시하고 복귀로 진행
        if self._ignore_next_result:
            self._ignore_next_result = False
            self.get_logger().info('이전 탐색 목표를 취소했습니다. home 으로 복귀합니다.')
            return

        # 골이 얼마나 오래 돌았는지 (즉시 실패 = 타이밍/localization 문제로 추정)
        runtime = None
        if self._goal_sent_time is not None:
            runtime = (self.get_clock().now() - self._goal_sent_time).nanoseconds / 1e9
        instant = (runtime is not None and runtime < self.min_goal_runtime)

        # ---- 복귀 단계 ----
        if self.state == self.RETURNING:
            if status == GoalStatus.STATUS_SUCCEEDED:
                self.get_logger().info('시작점 복귀 완료. 맵을 저장합니다.')
                self.save_map_and_finish()
            else:
                self.get_logger().warn(f'복귀 실패(status={status}). 잠시 후 재시도.')
                self._set_cooldown()   # 재시도/종료는 control_loop 이 결정
            return

        # ---- 탐색 단계 ----
        if status == GoalStatus.STATUS_SUCCEEDED:
            self.get_logger().info('구간 도착. 다음 프론티어 분석.')
            self.current_goal = None
            self.fail_count = 0
        else:
            rt = f'{runtime:.2f}s' if runtime is not None else '?'
            self.get_logger().warn(f'주행 실패(status={status}, {rt}).')
            self._register_failure(instant=instant)
            self._set_cooldown()
        # 다음 골은 control_loop(1Hz) 이 보냄 → 실패 폭주 방지

    def _register_failure(self, instant=False):
        """ 탐색 목표 실패 누적. 단, '즉시 실패'(짧은 시간 내 abort)는 보통
            localization/타이밍 문제이므로 블랙리스트에 집계하지 않고 그대로 재시도한다. """
        if instant:
            self.get_logger().warn(
                '즉시 실패(localization/타이밍 추정) → 블랙리스트 미집계, 잠시 후 같은 목표 재시도.')
            return
        self.fail_count += 1
        if self.current_goal is not None and self.fail_count >= self.max_goal_attempts:
            gx, gy = self.current_goal
            self.blacklist.append(self.current_goal)
            self.get_logger().warn(
                f'목표 ({gx:.2f}, {gy:.2f}) {self.fail_count}회 실패 → 포기(블랙리스트 {len(self.blacklist)}개). 다른 곳 탐색.'
            )
            self.current_goal = None
            self.fail_count = 0

    # ==================================================================
    # 복귀 (재시도 + 안전장치)
    # ==================================================================
    def _send_home_goal(self):
        self.return_attempts += 1
        hx, hy = self.home_pose
        self.get_logger().info(
            f'복귀 시도 {self.return_attempts}/{self.max_return_attempts} → home ({hx:.2f}, {hy:.2f})'
        )
        self.send_nav_goal(hx, hy)

    # ==================================================================
    # 온디맨드 '지금 마무리' (부분 맵 저장 + 복귀)
    # ==================================================================
    def _finish_now_callback(self, msg):
        """ 외부 트리거 수신: 무거운 처리는 control_loop 에서 (콜백은 플래그만 세움). """
        if self.state == self.DONE:
            return
        if not self._finish_requested:
            self.get_logger().warn('▶ 마무리 요청 수신: 곧 현재 맵 저장 후 복귀합니다.')
        self._finish_requested = True

    def _begin_finish_now(self):
        """ 현재 부분 맵을 즉시 저장하고, 탐색을 멈춘 뒤 home 으로 복귀.
            (전송/재시도/최종 저장은 기존 RETURNING 로직을 그대로 재사용) """
        self._finish_requested = False
        self.get_logger().warn('▶ 마무리 시작 → 부분 맵 저장 후 home 복귀.')

        # 1) 현재(부분) 맵 즉시 저장 — 복귀가 실패해도 데이터는 확보
        self._save_map_now()

        # 2) 복귀 상태로 전환
        self.state = self.RETURNING
        self.return_attempts = 0
        self._cooldown_until = None

        # 3) 탐색 주행 중이면 현재 목표 취소 (다음 틱에 home 목표 전송)
        if self.is_navigating and self._goal_handle is not None:
            self._ignore_next_result = True
            try:
                self._goal_handle.cancel_goal_async()
            except Exception as e:
                self.get_logger().warn(f'목표 취소 호출 실패(무시): {e}')

    def _save_map_now(self):
        """ 종료하지 않고 현재 맵만 저장 (_finished 를 건드리지 않음). """
        if not self._save_map_client.wait_for_service(timeout_sec=2.0):
            self.get_logger().error('/slam_toolbox/save_map 서비스 없음 → 부분 저장 건너뜀.')
            return
        req = SaveMap.Request()
        req.name.data = self.map_save_path
        self.get_logger().info(f'부분 맵 저장 요청 → {self.map_save_path}')
        fut = self._save_map_client.call_async(req)
        fut.add_done_callback(self._save_now_done_callback)

    def _save_now_done_callback(self, future):
        try:
            resp = future.result()
            if resp.result == 0:   # RESULT_SUCCESS
                self.get_logger().info(f'부분 맵 저장 완료: {self.map_save_path}.pgm / .yaml')
            else:
                self.get_logger().error(f'부분 맵 저장 실패(result={resp.result}).')
        except Exception as e:
            self.get_logger().error(f'부분 맵 저장 서비스 호출 오류: {e}')

    # ==================================================================
    # 맵 저장 후 종료
    # ==================================================================
    def save_map_and_finish(self):
        self.state = self.DONE
        if not self._save_map_client.wait_for_service(timeout_sec=5.0):
            self.get_logger().error('/slam_toolbox/save_map 서비스 없음. 저장 없이 종료.')
            self._finished = True
            return

        req = SaveMap.Request()
        req.name.data = self.map_save_path
        self.get_logger().info(f'맵 저장 요청 → {self.map_save_path}')
        future = self._save_map_client.call_async(req)
        future.add_done_callback(self.save_done_callback)

    def save_done_callback(self, future):
        try:
            resp = future.result()
            if resp.result == 0:   # RESULT_SUCCESS
                self.get_logger().info(f'맵 저장 완료: {self.map_save_path}.pgm / .yaml')
            else:
                self.get_logger().error(
                    f'맵 저장 실패(result={resp.result}). 경로/쓰기권한을 확인하세요.'
                )
        except Exception as e:
            self.get_logger().error(f'맵 저장 서비스 호출 오류: {e}')
        self._finished = True


def main(args=None):
    rclpy.init(args=args)
    node = ExplorationCoordinator()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, SystemExit):
        node.get_logger().info('노드를 종료합니다.')
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
