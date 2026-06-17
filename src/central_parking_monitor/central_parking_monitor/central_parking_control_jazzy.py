#!/usr/bin/env python3
#
# 프리미엄 관제형 비전 좌표계 자율 주차 제어 노드
# 개발: 김동석
#
# [알고리즘 v6.5 - 라인트레이서 제어권 회수 및 전방 정지 커스텀 버전]
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
from std_msgs.msg import String  # 제어권 전환 신호용 메시지 타입


# ── 제어 파라미터 ───────────────────────────────────────────────────────────────────
LINEAR_SPEED            =  0.012  # 기준 구동 선속도 (m/s)
KP_X                    =  0.15   # STATE 1: 웨이포인트 오차각 기준 조향 비례 게인
KP_HEADING              =  0.25   # STATE 2: 라인 안착 후 헤딩 정렬 회전 게인
MAX_ANG                 =  0.12   # 각속도 최대 포화 제한 (rad/s)
MIN_ANG                 =  0.01   # 각속도 최소 데드존 임계치

# [Waypoint 핵심 설정]
WAYPOINT_OFFSET         =  80.0   # 주차 마커 전방 가상 진입 게이트 거리 (px)
WAYPOINT_THRESHOLD      =  20.0   # 1→2단계 전환용 게이트 도달 인정 임계 거리 (px)

HEADING_THRESHOLD       =  1.5    # STATE 2→3: 정렬 완료로 인정할 헤딩 오차 (deg)
# 💡 [조정] 마커보다 확실히 앞쪽에 주차되도록 임계치 상향 (기존 35.0 -> 65.0)
ARRIVE_THRESHOLD        =  65.0   # STATE 3→4: 최종 주차 안착 및 정지 판정 거리 (px)

TARGET_LOCK_FRAMES      =  20     # 바닥 마커 안정화 프레임 수
THETA_FILTER_LEN        =  10     # 로봇 theta 이동평균 윈도우


class CentralParkingControllerJazzy(Node):

    def __init__(self):
        super().__init__('central_parking_controller_jazzy')

        self.declare_parameter('robot_namespace', '')
        self.robot_ns = self.get_parameter('robot_namespace').get_parameter_value().string_value

        qos           = QoSProfile(depth=10)
        cmd_topic     = f'/{self.robot_ns}/cmd_vel'       if self.robot_ns else '/cmd_vel'
        batt_topic    = f'/{self.robot_ns}/battery_state' if self.robot_ns else '/battery_state'

        self.pub      = self.create_publisher(TwistStamped, cmd_topic, qos)
        
        # 💡 [추가] 라인트레이서 제어권을 회수하기 위한 모드 퍼블리셔
        self.mode_pub = self.create_publisher(String, '/robot_mode', qos)
        self.parking_sequence_started = False

        self.batt_sub = self.create_subscription(BatteryState, batt_topic, self._batt_cb, qos)
        self.get_logger().info(f"📢 [{self.robot_ns if self.robot_ns else 'Global'}] 정밀 주차 시스템 가동 (토픽: {cmd_topic})")

        # 카메라 설정
        self.cap = cv2.VideoCapture(0)
        if not self.cap.isOpened():
            self.get_logger().error("❌ 웹캠을 열 수 없습니다.")
            sys.exit(1)

        # 💡 요청하신 마커 ID 동기화
        self.ROBOT_ID  = 1   
        self.TARGET_ID = 11  

        # 바닥 타깃 마커용 버퍼 및 고정 필드
        self.tgt_samples_x     = deque()
        self.tgt_samples_y     = deque()
        self.tgt_samples_theta = deque()
        self.tgt_locked        = False
        self.tgt_x             = None   
        self.tgt_y             = None   
        self.tgt_theta         = None   

        # 로봇 방향 필터
        self.theta_buf = deque(maxlen=THETA_FILTER_LEN)

        # 상태머신 초기화
        self.state          = 1
        self.initial_dist   = None   

        # 가속 슬롭 제어용 변수
        self.vel_lin = 0.0
        self.vel_ang = 0.0

        # 배터리 정보
        self.batt_v   = 0.0
        self.batt_pct = 0.0
        self.batt_ok  = False

        # ── 자가 보정 모니터링 변수 ──
        self.prev_dist = None               
        self.prev_e_head = None             
        self.linear_mismatch_timer = 0.0    
        self.angular_mismatch_timer = 0.0   
        self.linear_multiplier = 1.0
        self.angular_multiplier = 1.0

        self.create_timer(0.033, self._loop)

    def _batt_cb(self, msg):
        self.batt_v   = msg.voltage
        self.batt_pct = msg.percentage * 100.0 if msg.percentage <= 1.0 else msg.percentage
        self.batt_ok  = True

    def _pub_vel(self, lin, ang):
        msg                 = TwistStamped()
        msg.header.stamp    = self.get_clock().now().to_msg()
        msg.header.frame_id = 'base_link'
        msg.twist.linear.x  = lin
        msg.twist.angular.z = ang
        self.pub.publish(msg)

    @staticmethod
    def _ramp(current, target, step):
        if   current < target: return min(target, current + step)
        elif current > target: return max(target, current - step)
        return target

    @staticmethod
    def _marker_center_theta(corners):
        c  = corners[0]
        cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0
        cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4.0
        fx = (c[0][0] + c[1][0]) / 2.0
        fy = (c[0][1] + c[1][1]) / 2.0
        rx = (c[3][0] + c[2][0]) / 2.0
        ry = (c[3][1] + c[2][1]) / 2.0
        th = math.atan2(fy - ry, fx - rx)
        return cx, cy, th

    def _loop(self):
        if not self.cap.isOpened():
            return
        ret, frame = self.cap.read()
        if not ret:
            return

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        dic  = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        try:
            det             = cv2.aruco.ArucoDetector(dic, cv2.aruco.DetectorParameters())
            corners, ids, _ = det.detectMarkers(gray)
        except AttributeError:
            params          = (cv2.aruco.DetectorParameters_create()
                               if hasattr(cv2.aruco, 'DetectorParameters_create')
                               else cv2.aruco.DetectorParameters())
            corners, ids, _ = cv2.aruco.detectMarkers(gray, dic, parameters=params)

        robot_x = robot_y = robot_theta = None

        # ── 마커 센싱 및 데이터 필터링 ─────────────────────────────────────────
        if ids is not None:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            for i, mid in enumerate(ids.flatten()):
                cx, cy, th = self._marker_center_theta(corners[i])

                if mid == self.ROBOT_ID:
                    self.theta_buf.append(th)
                    robot_x     = int(cx)
                    robot_y     = int(cy)
                    robot_theta = float(np.mean(self.theta_buf))

                    # 로봇 후방 헤딩 방향 표시 (적색 화살표)
                    ax = int(cx - 45 * math.cos(robot_theta))
                    ay = int(cy - 45 * math.sin(robot_theta))
                    cv2.arrowedLine(frame, (robot_x, robot_y), (ax, ay), (0, 0, 255), 2, tipLength=0.3)

                elif mid == self.TARGET_ID and not self.tgt_locked:
                    self.tgt_samples_x.append(cx)
                    self.tgt_samples_y.append(cy)
                    self.tgt_samples_theta.append(th)
                    if len(self.tgt_samples_x) >= TARGET_LOCK_FRAMES:
                        self.tgt_x     = float(np.mean(self.tgt_samples_x))
                        self.tgt_y     = float(np.mean(self.tgt_samples_y))
                        self.tgt_theta = float(np.mean(self.tgt_samples_theta))
                        self.tgt_locked = True
                        self.get_logger().warn(
                            f"🔒 [타깃 락 완료] X:{self.tgt_x:.1f} Y:{self.tgt_y:.1f} θ:{math.degrees(self.tgt_theta):.1f}°")
                        
                        # 💡 타깃 락 온 시점에 라인트레이서 노드에 즉시 모드 전파
                        if not self.parking_sequence_started:
                            mode_msg = String()
                            mode_msg.data = "PARKING"
                            self.mode_pub.publish(mode_msg)
                            self.parking_sequence_started = True
                            self.get_logger().warn("🎯 마커 감지! 라인트레이서 제어권을 회수하고 주차가동합니다.")

        # ── 가상 주차 레일 및 진입 게이트(Waypoint) 시각화 ───────────────────────
        wp_x = wp_y = None
        if self.tgt_locked:
            tx, ty, tth = int(self.tgt_x), int(self.tgt_y), self.tgt_theta

            # 타깃 가이드 화살표 (녹색)
            gx = int(tx + 50 * math.cos(tth))
            gy = int(ty + 50 * math.sin(tth))
            cv2.arrowedLine(frame, (tx, ty), (gx, gy), (0, 255, 0), 2, tipLength=0.25)

            # 타깃 포즈 벡터를 관통하는 하늘색 가상 연장선
            cos_t = math.cos(tth)
            sin_t = math.sin(tth)
            p1_x = int(tx - 1000 * cos_t)
            p1_y = int(ty - 1000 * sin_t)
            p2_x = int(tx + 1000 * cos_t)
            p2_y = int(ty + 1000 * sin_t)
            cv2.line(frame, (p1_x, p1_y), (p2_x, p2_y), (255, 255, 0), 1)

            # [Waypoint 생성] 마커 전방 WAYPOINT_OFFSET 거리에 가상의 진입 포인트 생성
            wp_x = self.tgt_x + WAYPOINT_OFFSET * cos_t
            wp_y = self.tgt_y + WAYPOINT_OFFSET * sin_t
            
            # 화면 상에 주황색 원으로 진입 게이트 시각화 표시
            cv2.circle(frame, (int(wp_x), int(wp_y)), 8, (0, 165, 255), -1)
            cv2.putText(frame, "Gate (WP)", (int(wp_x) + 12, int(wp_y) + 5), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 165, 255), 2)

        # ── 주차 알고리즘 코어 제어 루프 ─────────────────────────────────────────
        target_lin = 0.0
        target_ang = 0.0

        if robot_x is not None and self.tgt_locked and wp_x is not None:
            dx   = self.tgt_x - robot_x
            dy   = self.tgt_y - robot_y
            dist = math.sqrt(dx**2 + dy**2)

            # 가상 진입 게이트(Waypoint)까지의 잔여 거리
            dw_x = wp_x - robot_x
            dw_y = wp_y - robot_y
            dist_to_wp = math.sqrt(dw_x**2 + dw_y**2)

            if self.initial_dist is None:
                self.initial_dist = dist
                self.get_logger().warn(f"📏 [주차 초기거리 기록] {self.initial_dist:.1f}px")

            # 횡방향 오차(e_lat) 계산
            e_lat = -dx * math.sin(self.tgt_theta) + dy * math.cos(self.tgt_theta)
            
            e_head = math.atan2(math.sin(self.tgt_theta - robot_theta), 
                                math.cos(self.tgt_theta - robot_theta))

            # ── [자가 보정 슈퍼바이저] ──
            if self.state in [1, 3]:
                if self.prev_dist is not None:
                    if dist > self.prev_dist + 0.1:
                        self.linear_mismatch_timer += 0.033
                        if self.linear_mismatch_timer >= 2.0:
                            self.linear_multiplier *= -1.0
                            self.get_logger().error(f"⚠️ [비상 반전 교정] 거리가 멀어짐 감지! 앞/뒤 제어 역전. 배율: {self.linear_multiplier}")
                            self.linear_mismatch_timer = 0.0
                    else:
                        self.linear_mismatch_timer = max(0.0, self.linear_mismatch_timer - 0.1)
                self.prev_dist = dist
            else:
                self.prev_dist = None
                self.linear_mismatch_timer = 0.0

            if self.state == 2:
                if self.prev_e_head is not None:
                    if abs(e_head) < math.radians(165.0) and abs(e_head) > abs(self.prev_e_head) + math.radians(0.1):
                        self.angular_mismatch_timer += 0.033
                        if self.angular_mismatch_timer >= 2.0:
                            self.angular_multiplier *= -1.0
                            self.get_logger().error(f"⚠️ [조향 반전 교정] 각도 오차 증가 감지! 좌/우 제어 역전. 배율: {self.angular_multiplier}")
                            self.angular_mismatch_timer = 0.0
                    else:
                        self.angular_mismatch_timer = max(0.0, self.angular_mismatch_timer - 0.1)
                self.prev_e_head = e_head
            else:
                self.prev_e_head = None
                self.angular_mismatch_timer = 0.0

            # ─────────────────────────────────────────────────────────────────
            # STATE 1: 가상 진입 게이트 추적 단계
            # ─────────────────────────────────────────────────────────────────
            if self.state == 1:
                if dist_to_wp <= WAYPOINT_THRESHOLD:
                    target_lin = 0.0
                    target_ang = 0.0
                    self.state = 2
                    self.get_logger().warn(f"🚨 [STATE 1→2] 진입 게이트(WP) 도달 완료 ({dist_to_wp:.1f}px). 정렬 페이즈 전환.")
                else:
                    proj_wp = dw_x * math.cos(robot_theta) + dw_y * math.sin(robot_theta)
                    
                    if proj_wp >= 0:
                        direction_sign = 1.0
                        theta_to_wp = math.atan2(dw_y, dw_x)
                        e_wp = math.atan2(math.sin(theta_to_wp - robot_theta), math.cos(theta_to_wp - robot_theta))
                    else:
                        direction_sign = -1.0
                        theta_to_wp = math.atan2(dw_y, dw_x)
                        e_wp = math.atan2(math.sin(theta_to_wp - (robot_theta + math.pi)), math.cos(theta_to_wp - (robot_theta + math.pi)))

                    target_lin = direction_sign * LINEAR_SPEED
                    raw_ang = direction_sign * KP_X * e_wp
                    if abs(raw_ang) < MIN_ANG:
                        raw_ang = 0.0
                    target_ang = max(-MAX_ANG, min(MAX_ANG, raw_ang))

                    self.get_logger().info(
                        f"⬇️  [STATE 1: 게이트추적] 게이트거리:{dist_to_wp:.1f}px | 마커거리:{dist:.1f}px | Ang:{target_ang:+.3f}",
                        throttle_duration_sec=0.5)

            # ─────────────────────────────────────────────────────────────────
            # STATE 2: 게이트 안착 후 정밀 제자리 슬라이딩 회전
            # ─────────────────────────────────────────────────────────────────
            elif self.state == 2:
                target_lin = 0.0

                if abs(e_head) <= math.radians(HEADING_THRESHOLD):
                    target_ang = 0.0
                    self.state = 3
                    self.get_logger().warn(f"✅ [STATE 2→3] 헤딩 정렬 완료 ({math.degrees(e_head):.1f}°). 직선 후진 도킹 시작.")
                else:
                    raw_ang = -KP_HEADING * e_head
                    
                    if abs(raw_ang) < MIN_ANG:
                        raw_ang = MIN_ANG * np.sign(raw_ang) if raw_ang != 0 else MIN_ANG
                    target_ang = max(-MAX_ANG, min(MAX_ANG, raw_ang))

                    self.get_logger().info(
                        f"🔄 [STATE 2: 헤딩정렬] 오차: {math.degrees(e_head):+.1f}° | e_lat:{e_lat:+.1f}px | Cmd_Ang:{target_ang:+.2f}",
                        throttle_duration_sec=0.4)

            # ─────────────────────────────────────────────────────────────────
            # STATE 3: 조향 잠금 직선 후진 최종 안착 단계
            # ─────────────────────────────────────────────────────────────────
            elif self.state == 3:
                if dist > ARRIVE_THRESHOLD:
                    proj = dx * math.cos(robot_theta) + dy * math.sin(robot_theta)
                    direction_sign = -1.0 if proj < 0 else 1.0
                    target_lin = direction_sign * LINEAR_SPEED
                    target_ang = 0.0  
                    self.get_logger().info(
                        f"🚀 [STATE 3: 직선안착] 도킹 중... 남은 거리: {dist:.1f}px",
                        throttle_duration_sec=0.4)
                else:
                    target_lin = 0.0
                    target_ang = 0.0
                    self.state = 4
                    self.get_logger().warn("🏁 [주차 완료] 마커 전방에 안전하게 안착했습니다!")

            elif self.state == 4:
                target_lin = 0.0
                target_ang = 0.0

        # 제어권 미획득 시(마커 미발견 상태)에는 속도를 명령하지 않음 (라인트레이서에 양보)
        if not self.parking_sequence_started:
            return

        # ── 자가 보정 제어 부호 배율 곱셈 적용 ────────────────────────────────────
        target_lin *= self.linear_multiplier
        target_ang *= self.angular_multiplier

        # ── 가감속 슬롭 프로파일러 적용 및 속도 발행 ───────────────────────────────
        self.vel_lin = self._ramp(self.vel_lin, target_lin, 0.004)
        self.vel_ang = self._ramp(self.vel_ang, target_ang, 0.04)
        self._pub_vel(self.vel_lin, self.vel_ang)

        # ── HUD 그래픽 모니터링 레이어 ──────────────────────────────────────────
        if self.batt_ok:
            col = (0, 0, 255) if self.batt_pct < 30 else (0, 255, 0)
            cv2.putText(frame, f"Batt: {self.batt_pct:.1f}% ({self.batt_v:.2f}V)",
                        (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        else:
            cv2.putText(frame, "Batt: waiting...", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        state_str = f"STATE:{self.state}"
        if robot_x is not None and self.tgt_locked:
            state_str += f"  Lat_Err:{e_lat:+.1f}px  Head_Err:{math.degrees(e_head):+.1f}deg  Dist:{dist:.1f}px"
        cv2.putText(frame, state_str, (15, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 2)

        if not self.tgt_locked:
            n = len(self.tgt_samples_x)
            cv2.putText(frame, f"Stabilizing target {n}/{TARGET_LOCK_FRAMES}",
                        (15, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 2)

        mult_str = f"L_mult:{self.linear_multiplier}  A_mult:{self.angular_multiplier}"
        cv2.putText(frame, mult_str, (15, frame.shape[0] - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)

        cv2.imshow(f"Parking Monitor [{self.robot_ns if self.robot_ns else 'Global'}]", frame)
        cv2.waitKey(1)

    def emergency_stop(self):
        self.get_logger().info("🛑 [안전 시스템] 원격 강제 정지 및 비디오 인터페이스 해제")
        for _ in range(3):
            self._pub_vel(0.0, 0.0)
            time.sleep(0.1)
        if self.cap.isOpened():
            self.cap.release()
        cv2.destroyAllWindows()


def main(args=None):
    rclpy.init(args=args)
    node = CentralParkingControllerJazzy()
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