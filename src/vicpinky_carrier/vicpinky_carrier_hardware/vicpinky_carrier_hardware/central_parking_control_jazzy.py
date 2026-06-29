#!/usr/bin/env python3
#
# 중앙 관제형 비전 좌표계 자율 주차 제어 노드 (주차 단독 실행 버전)
# 기반: 알고리즘 v6.7 → 라인트레이싱/모드발행 제거, 순수 후진 주차만 수행
#
# 이 노드를 실행하면:
#   1) 웹캠에서 ArUco 마커를 검출
#   2) 로봇 마커(robot_id)와 주차 마커(parking_id)가 둘 다 잡히면
#   3) 곧바로 후진 주차 시퀀스 1회 수행 (게이트추적 → 헤딩정렬 → 후진도킹 → 완료)
#
# 사용 예:
#   ros2 run <패키지> central_parking_only
#   ros2 run <패키지> central_parking_only --ros-args -p robot_id:=4 -p parking_id:=14
#

import sys
import time
import math
import cv2
import numpy as np
from collections import deque

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile
from geometry_msgs.msg import TwistStamped
from sensor_msgs.msg import BatteryState


# ── 로봇 ↔ 주차 마커 고정 매핑 (1→11, 3→13, 4→14) ──
# robot_id만 지정하면 parking_id를 자동으로 채워준다.
# parking_id를 명시적으로 주면 그 값이 우선한다.
ROBOT_PARKING_MAP = {1: 11, 3: 13, 4: 14}


class CentralParkingOnly(Node):
    def __init__(self):
        super().__init__('central_parking_only')
        qos = QoSProfile(depth=10)

        # ── 1. ROS 2 파라미터 선언 ──
        self.declare_parameter('robot_id', 4)
        self.declare_parameter('parking_id', -1)   # -1이면 매핑 테이블에서 자동 결정
        self.declare_parameter('camera_index', 0)
        self.declare_parameter('robot_namespace', '')

        # 제어 게인 및 임계치
        self.declare_parameter('kp_x', 0.15)                 # STATE 1: 후진 조향 게인
        self.declare_parameter('kp_heading', 0.25)           # STATE 2: 헤딩 정렬 회전 게인
        self.declare_parameter('park_linear_speed', 0.012)   # 기준 구동 선속도 (m/s)
        self.declare_parameter('max_angular_z', 0.12)
        self.declare_parameter('min_angular_z', 0.01)

        # 주차 기하학
        self.declare_parameter('waypoint_offset', 80.0)
        self.declare_parameter('waypoint_threshold', 20.0)
        self.declare_parameter('heading_threshold_deg', 1.5)
        self.declare_parameter('park_dist_threshold_px', 35.0)

        self.declare_parameter('target_lock_frames', 20)
        self.declare_parameter('theta_filter_len', 10)
        self.declare_parameter('enable_gui', True)
        self.declare_parameter('camera_rotate_ccw90', True)  # 카메라 90도 반시계 보정 on/off

        # 파라미터 → 인스턴스 변수
        self.robot_id = self.get_parameter('robot_id').value
        parking_param = self.get_parameter('parking_id').value
        self.camera_index = self.get_parameter('camera_index').value
        self.robot_ns = self.get_parameter('robot_namespace').value

        # parking_id 자동 결정 로직
        if parking_param is not None and parking_param >= 0:
            self.parking_id = parking_param
        elif self.robot_id in ROBOT_PARKING_MAP:
            self.parking_id = ROBOT_PARKING_MAP[self.robot_id]
        else:
            self.parking_id = 14
            self.get_logger().warn(
                f"⚠️ robot_id={self.robot_id}에 대한 매핑이 없어 parking_id를 기본값 14로 둡니다.")

        self.KP_X = self.get_parameter('kp_x').value
        self.KP_HEADING = self.get_parameter('kp_heading').value
        self.LINEAR_SPEED = self.get_parameter('park_linear_speed').value
        self.MAX_ANGULAR_Z = self.get_parameter('max_angular_z').value
        self.MIN_ANGULAR_Z = self.get_parameter('min_angular_z').value

        self.WAYPOINT_OFFSET = self.get_parameter('waypoint_offset').value
        self.WAYPOINT_THRESHOLD = self.get_parameter('waypoint_threshold').value
        self.HEADING_THRESHOLD = math.radians(self.get_parameter('heading_threshold_deg').value)
        self.ARRIVE_THRESHOLD = self.get_parameter('park_dist_threshold_px').value

        self.TARGET_LOCK_FRAMES = self.get_parameter('target_lock_frames').value
        self.THETA_FILTER_LEN = self.get_parameter('theta_filter_len').value
        self.enable_gui = self.get_parameter('enable_gui').value
        self.rotate_ccw90 = self.get_parameter('camera_rotate_ccw90').value

        # ── 2. 상태머신 변수 ──
        # state 1: 게이트(WP) 추적 / 2: 제자리 헤딩 정렬 / 3: 직선 후진 도킹 / 4: 완료
        self.state = 1
        self.initial_dist = None

        self.vel_lin = 0.0
        self.vel_ang = 0.0

        self.batt_v = 0.0
        self.batt_pct = 0.0
        self.batt_ok = False

        # ── 3. 타깃/로봇 필터 버퍼 ──
        self.tgt_samples_x = deque()
        self.tgt_samples_y = deque()
        self.tgt_samples_theta = deque()
        self.tgt_locked = False
        self.tgt_x = None
        self.tgt_y = None
        self.tgt_theta = None
        self.theta_buf = deque(maxlen=self.THETA_FILTER_LEN)

        # ── 4. 토픽 설정 (모드 발행 제거, cmd_vel만) ──
        cmd_topic = f'/{self.robot_ns}/cmd_vel' if self.robot_ns else '/cmd_vel'
        batt_topic = f'/{self.robot_ns}/battery_state' if self.robot_ns else '/battery_state'

        self.cmd_vel_pub = self.create_publisher(TwistStamped, cmd_topic, qos)
        self.batt_sub = self.create_subscription(BatteryState, batt_topic, self._batt_cb, qos)

        self.get_logger().info(
            f"📢 [주차 단독] robot_id={self.robot_id} → parking_id={self.parking_id} | cmd_topic={cmd_topic}")

        # ── 5. ArUco 설정 (OpenCV 버전 호환) ──
        self.aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        try:
            self.aruco_params = cv2.aruco.DetectorParameters()
            self.aruco_detector = cv2.aruco.ArucoDetector(self.aruco_dict, self.aruco_params)
            self.use_new_aruco = True
            self.get_logger().info("ℹ️ 최신 OpenCV ArUcoDetector API 적용")
        except AttributeError:
            self.use_new_aruco = False
            if hasattr(cv2.aruco, 'DetectorParameters_create'):
                self.aruco_params = cv2.aruco.DetectorParameters_create()
            else:
                self.aruco_params = cv2.aruco.DetectorParameters()
            self.get_logger().info("ℹ️ 레거시 OpenCV ArUco API 적용")

        # ── 6. 웹캠 로드 (V4L2 + Fallback) ──
        self.get_logger().info(f"📷 웹캠 연결 시도 (V4L2, index={self.camera_index})")
        self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            fallback_index = 1 if self.camera_index == 0 else 0
            self.get_logger().warn(f"⚠️ index {self.camera_index} 실패 → {fallback_index} 재시도")
            self.cap = cv2.VideoCapture(fallback_index, cv2.CAP_V4L2)
            if not self.cap.isOpened():
                self.get_logger().error("❌ 사용 가능한 웹캠을 찾을 수 없습니다.")
                raise RuntimeError("카메라 로드 실패")
        self.get_logger().info("✅ 웹캠 로드 완료")

        # 단일 제어 루프 (33ms)
        self.create_timer(0.033, self.camera_loop)

    def _batt_cb(self, msg):
        self.batt_v = msg.voltage
        self.batt_pct = msg.percentage * 100.0 if msg.percentage <= 1.0 else msg.percentage
        self.batt_ok = True

    def _publish_vel(self, lin, ang):
        msg = TwistStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'base_link'
        msg.twist.linear.x = lin
        msg.twist.angular.z = ang
        self.cmd_vel_pub.publish(msg)

    @staticmethod
    def _ramp(current, target, step):
        if current < target:
            return min(target, current + step)
        elif current > target:
            return max(target, current - step)
        return target

    @staticmethod
    def _marker_center_theta(corners):
        c = corners[0]
        cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0
        cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4.0
        fx = (c[0][0] + c[1][0]) / 2.0
        fy = (c[0][1] + c[1][1]) / 2.0
        rx = (c[3][0] + c[2][0]) / 2.0
        ry = (c[3][1] + c[2][1]) / 2.0
        th = math.atan2(fy - ry, fx - rx)
        return cx, cy, th

    def _show_frame(self, frame):
        if not self.enable_gui:
            return
        try:
            cv2.imshow(f"Parking Monitor [{self.robot_ns if self.robot_ns else 'Global'}]", frame)
            cv2.waitKey(1)
        except Exception as e:
            print(f"[EXC] _show_frame 예외: {e}", file=sys.stderr, flush=True)
            self.enable_gui = False

    def camera_loop(self):
        ret, frame = self.cap.read()
        if not ret:
            return

        # 카메라 90도 반시계 보정 (기준 좌표계 정렬)
        if self.rotate_ccw90:
            frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        if self.use_new_aruco:
            corners, ids, _ = self.aruco_detector.detectMarkers(gray)
        else:
            corners, ids, _ = cv2.aruco.detectMarkers(gray, self.aruco_dict, parameters=self.aruco_params)

        robot_x = robot_y = robot_theta = None
        robot_in_frame = False

        if ids is not None:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            id_list = ids.flatten().tolist()
            robot_in_frame = self.robot_id in id_list

            for i, mid in enumerate(id_list):
                cx, cy, th = self._marker_center_theta(corners[i])

                if mid == self.robot_id:
                    self.theta_buf.append(th)
                    robot_x = int(cx)
                    robot_y = int(cy)
                    robot_theta = float(np.mean(self.theta_buf))

                    ax = int(cx - 45 * math.cos(robot_theta))
                    ay = int(cy - 45 * math.sin(robot_theta))
                    cv2.arrowedLine(frame, (robot_x, robot_y), (ax, ay), (0, 0, 255), 2, tipLength=0.3)

                elif mid == self.parking_id and not self.tgt_locked:
                    # 로봇이 함께 보일 때만 타깃 샘플 적재 (안정적 락)
                    if robot_in_frame:
                        self.tgt_samples_x.append(cx)
                        self.tgt_samples_y.append(cy)
                        self.tgt_samples_theta.append(th)
                        if len(self.tgt_samples_x) >= self.TARGET_LOCK_FRAMES:
                            self.tgt_x = float(np.mean(self.tgt_samples_x))
                            self.tgt_y = float(np.mean(self.tgt_samples_y))
                            self.tgt_theta = float(np.mean(self.tgt_samples_theta))
                            self.tgt_locked = True
                            self.get_logger().warn(
                                f"🔒 [타깃 락] X:{self.tgt_x:.1f} Y:{self.tgt_y:.1f} "
                                f"θ:{math.degrees(self.tgt_theta):.1f}° → 후진 주차 시작")

        # ── 주차 마커 기준 후진 게이트(WP) 시각화 + 좌표 산출 ──
        wp_x = None
        if self.tgt_locked:
            tx, ty, tth = int(self.tgt_x), int(self.tgt_y), self.tgt_theta
            cos_t = math.cos(tth)
            sin_t = math.sin(tth)

            # 주차 마커 기준 '뒤쪽'(후진 진입 방향) 화살표
            gx = int(tx - 50 * cos_t)
            gy = int(ty - 50 * sin_t)
            cv2.arrowedLine(frame, (tx, ty), (gx, gy), (0, 255, 0), 2, tipLength=0.25)

            # 주차 라인 (마커를 지나는 직선)
            p1_x, p1_y = int(tx - 1000 * cos_t), int(ty - 1000 * sin_t)
            p2_x, p2_y = int(tx + 1000 * cos_t), int(ty + 1000 * sin_t)
            cv2.line(frame, (p1_x, p1_y), (p2_x, p2_y), (255, 255, 0), 1)

            # 후진 진입 게이트: 마커 뒤쪽(-offset)
            wp_x = self.tgt_x - self.WAYPOINT_OFFSET * cos_t
            wp_y = self.tgt_y - self.WAYPOINT_OFFSET * sin_t
            cv2.circle(frame, (int(wp_x), int(wp_y)), 8, (0, 165, 255), -1)
            cv2.putText(frame, "Gate (WP)", (int(wp_x) + 12, int(wp_y) + 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 165, 255), 2)

        target_lin = 0.0
        target_ang = 0.0
        e_lat = 0.0
        e_head = 0.0
        dist = 0.0

        if robot_x is not None and self.tgt_locked and wp_x is not None:
            dx = self.tgt_x - robot_x
            dy = self.tgt_y - robot_y
            dist = math.sqrt(dx ** 2 + dy ** 2)

            dw_x = wp_x - robot_x
            dw_y = wp_y - robot_y
            dist_to_wp = math.sqrt(dw_x ** 2 + dw_y ** 2)

            if self.initial_dist is None:
                self.initial_dist = dist
                self.get_logger().warn(f"📏 [초기거리] {self.initial_dist:.1f}px")

            e_lat = -dx * math.sin(self.tgt_theta) + dy * math.cos(self.tgt_theta)
            e_head = math.atan2(math.sin(self.tgt_theta - robot_theta),
                                math.cos(self.tgt_theta - robot_theta))

            # ── STATE 1: 진입 게이트(WP) 추적 ──
            if self.state == 1:
                if dist_to_wp <= self.WAYPOINT_THRESHOLD:
                    target_lin = 0.0
                    target_ang = 0.0
                    self.state = 2
                    self.get_logger().warn(
                        f"🔄 [STATE 1→2] 게이트 도달 ({dist_to_wp:.1f}px). 헤딩 정렬 시작.")
                else:
                    # 로봇 전방축 기준 WP 투영으로 전진/후진 동적 결정
                    proj_wp = dw_x * math.cos(robot_theta) + dw_y * math.sin(robot_theta)
                    if proj_wp >= 0:
                        # WP가 전방 → 후진으로 접근
                        direction_sign = -1.0
                        theta_to_wp = math.atan2(dw_y, dw_x)
                        e_wp = math.atan2(math.sin(theta_to_wp - robot_theta),
                                          math.cos(theta_to_wp - robot_theta))
                    else:
                        # WP가 후방 → 전진으로 접근
                        direction_sign = 1.0
                        theta_to_wp = math.atan2(dw_y, dw_x)
                        e_wp = math.atan2(math.sin(theta_to_wp - (robot_theta + math.pi)),
                                          math.cos(theta_to_wp - (robot_theta + math.pi)))

                    target_lin = direction_sign * self.LINEAR_SPEED
                    raw_ang = direction_sign * self.KP_X * e_wp
                    if abs(raw_ang) < self.MIN_ANGULAR_Z:
                        raw_ang = 0.0
                    target_ang = max(-self.MAX_ANGULAR_Z, min(self.MAX_ANGULAR_Z, raw_ang))

                    self.get_logger().info(
                        f"⬇️ [S1 게이트추적] WP:{dist_to_wp:.1f}px 마커:{dist:.1f}px Ang:{target_ang:+.3f}",
                        throttle_duration_sec=0.5)

            # ── STATE 2: 제자리 헤딩 정렬 ──
            elif self.state == 2:
                target_lin = 0.0
                if abs(e_head) <= self.HEADING_THRESHOLD:
                    target_ang = 0.0
                    self.state = 3
                    self.get_logger().warn(
                        f"✅ [STATE 2→3] 헤딩 정렬 완료 ({math.degrees(e_head):.1f}°). 후진 도킹 시작.")
                else:
                    raw_ang = -self.KP_HEADING * e_head
                    if abs(raw_ang) < self.MIN_ANGULAR_Z:
                        raw_ang = self.MIN_ANGULAR_Z * np.sign(raw_ang) if raw_ang != 0 else self.MIN_ANGULAR_Z
                    target_ang = max(-self.MAX_ANGULAR_Z, min(self.MAX_ANGULAR_Z, raw_ang))

                    self.get_logger().info(
                        f"🔄 [S2 헤딩정렬] 오차:{math.degrees(e_head):+.1f}° Cmd_Ang:{target_ang:+.2f}",
                        throttle_duration_sec=0.4)

            # ── STATE 3: 조향 잠금 직선 후진 도킹 ──
            elif self.state == 3:
                if dist > self.ARRIVE_THRESHOLD:
                    proj = dx * math.cos(robot_theta) + dy * math.sin(robot_theta)
                    direction_sign = 1.0 if proj < 0 else -1.0
                    target_lin = direction_sign * self.LINEAR_SPEED
                    target_ang = 0.0
                    self.get_logger().info(
                        f"🚀 [S3 후진도킹] 남은거리:{dist:.1f}px",
                        throttle_duration_sec=0.4)
                else:
                    target_lin = 0.0
                    target_ang = 0.0
                    self.state = 4
                    self.get_logger().warn("🏁 [주차 완료] 마커 중앙 안착 성공!")

            # ── STATE 4: 완료 정지 ──
            elif self.state == 4:
                target_lin = 0.0
                target_ang = 0.0

        # 램프 적용 후 발행
        self.vel_lin = self._ramp(self.vel_lin, target_lin, 0.004)
        self.vel_ang = self._ramp(self.vel_ang, target_ang, 0.04)
        self._publish_vel(self.vel_lin, self.vel_ang)

        # ── HUD ──
        if self.batt_ok:
            col = (0, 0, 255) if self.batt_pct < 30 else (0, 255, 0)
            cv2.putText(frame, f"Batt: {self.batt_pct:.1f}% ({self.batt_v:.2f}V)",
                        (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        else:
            cv2.putText(frame, "Batt: waiting...", (15, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        state_names = {1: "1:GATE_TRACK", 2: "2:HEADING_ALIGN", 3: "3:REVERSE_DOCK", 4: "4:PARKED_DONE"}
        state_str = f"R{self.robot_id}->P{self.parking_id}  STATE: {state_names.get(self.state)}"
        if robot_x is not None and self.tgt_locked:
            state_str += f" | Lat:{e_lat:+.1f}px | Head:{math.degrees(e_head):+.1f}deg | Dist:{dist:.1f}px"
        cv2.putText(frame, state_str, (15, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 2)

        if not self.tgt_locked:
            n = len(self.tgt_samples_x)
            cv2.putText(frame, f"Stabilizing target {n}/{self.TARGET_LOCK_FRAMES}",
                        (15, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 2)

        self._show_frame(frame)

    def emergency_stop(self):
        self.get_logger().info("🛑 [안전 정지] 정지 명령 발행 및 인터페이스 해제")
        for _ in range(3):
            self._publish_vel(0.0, 0.0)
            time.sleep(0.1)
        if self.cap.isOpened():
            self.cap.release()
        cv2.destroyAllWindows()


def main(args=None):
    rclpy.init(args=args)
    node = CentralParkingOnly()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.emergency_stop()
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()