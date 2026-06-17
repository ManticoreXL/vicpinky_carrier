#!/usr/bin/env python3
#
# 중앙 관제형 비전 좌표계 자율 주차 제어 노드
# 통합 버전: ROS 2 파라미터 + 알고리즘 v6.7 (확정 후진 패치 및 슈퍼바이저 단축)
# 개발: 김동석
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
from std_msgs.msg import String             
from sensor_msgs.msg import BatteryState

class CentralParkingController(Node):
    def __init__(self):
        super().__init__('central_parking_controller_jazzy')
        qos = QoSProfile(depth=10)
        
        # ── 1. ROS 2 파라미터 선언 ──
        self.declare_parameter('parking_id', 11)           
        self.declare_parameter('robot_id', 1)              
        self.declare_parameter('camera_index', 0)          
        self.declare_parameter('robot_namespace', '')      

        # 제어 게인 및 임계치 파라미터화
        self.declare_parameter('kp_x', 0.15)               # STATE 1: 후진 조향 비례 게인
        self.declare_parameter('kp_heading', 0.25)         # STATE 2: 헤딩 정렬 회전 게인
        self.declare_parameter('park_linear_speed', 0.012)  # 기준 구동 선속도 (m/s)
        self.declare_parameter('max_angular_z', 0.12)      
        self.declare_parameter('min_angular_z', 0.01)      
        
        # 주차 기하학 파라미터
        self.declare_parameter('waypoint_offset', 80.0)    
        self.declare_parameter('waypoint_threshold', 20.0) 
        self.declare_parameter('heading_threshold_deg', 1.5) 
        self.declare_parameter('park_dist_threshold_px', 65.0) 
        
        self.declare_parameter('target_lock_frames', 20)   
        self.declare_parameter('theta_filter_len', 10)     
        self.declare_parameter('enable_gui', True)          

        # 파라미터 값 인스턴스 변수 매핑
        self.parking_id = self.get_parameter('parking_id').value
        self.robot_id = self.get_parameter('robot_id').value
        self.camera_index = self.get_parameter('camera_index').value
        self.robot_ns = self.get_parameter('robot_namespace').value

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
        
        # ── 2. 상태머신 및 제어권 스위칭 변수 초기화 ──
        self.state = 1
        self.parking_sequence_started = False  
        self.initial_dist = None

        self.vel_lin = 0.0
        self.vel_ang = 0.0

        self.batt_v = 0.0
        self.batt_pct = 0.0
        self.batt_ok = False

        # ── 3. 자가 보정 슈퍼바이저 변수 ──
        self.prev_dist = None               
        self.prev_err = None             
        self.linear_mismatch_timer = 0.0    
        self.angular_mismatch_timer = 0.0   
        self.linear_multiplier = 1.0
        self.angular_multiplier = 1.0

        # ── 4. 데이터 필터링용 버퍼 (deque) 생성 ──
        self.tgt_samples_x = deque()
        self.tgt_samples_y = deque()
        self.tgt_samples_theta = deque()
        self.tgt_locked = False
        self.tgt_x = None   
        self.tgt_y = None   
        self.tgt_theta = None   
        self.theta_buf = deque(maxlen=self.THETA_FILTER_LEN)

        # ── 5. ROS 2 토픽 통신 설정 ──
        cmd_topic = f'/{self.robot_ns}/cmd_vel' if self.robot_ns else '/cmd_vel'
        batt_topic = f'/{self.robot_ns}/battery_state' if self.robot_ns else '/battery_state'
        
        self.cmd_vel_pub = self.create_publisher(TwistStamped, cmd_topic, qos)
        self.robot_mode_pub = self.create_publisher(String, '/robot_mode', qos)
        self.batt_sub = self.create_subscription(BatteryState, batt_topic, self._batt_cb, qos)
        
        self.get_logger().info(f"📢 [{self.robot_ns if self.robot_ns else 'Global'}] v6.7 주차제어 시스템 초기화 완료 (토픽: {cmd_topic})")

        # ── 6. 아루코 마커 설정 및 OpenCV 버전 호환성 예외 처리 ──
        self.aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        
        try:
            self.aruco_params = cv2.aruco.DetectorParameters()
            self.aruco_detector = cv2.aruco.ArucoDetector(self.aruco_dict, self.aruco_params)
            self.use_new_aruco = True
            self.get_logger().info("ℹ️ 최신 OpenCV ArUcoDetector API를 적용합니다.")
        except AttributeError:
            self.use_new_aruco = False
            if hasattr(cv2.aruco, 'DetectorParameters_create'):
                self.aruco_params = cv2.aruco.DetectorParameters_create()
            else:
                self.aruco_params = cv2.aruco.DetectorParameters()
            self.get_logger().info("ℹ️ 레거시 OpenCV ArUco API를 적용합니다. (DetectorParameters_create 구조 할당)")

        # ── 7. V4L2 백엔드 명시적 지정을 통한 웹캠 로드 및 Fallback ──
        self.get_logger().info(f"📷 웹캠 연결 시도 (V4L2 백엔드 사용, 인덱스: {self.camera_index})")
        self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_V4L2)
        
        if not self.cap.isOpened():
            fallback_index = 1 if self.camera_index == 0 else 0
            self.get_logger().warn(f"⚠️ 카메라 인덱스 {self.camera_index}번 실패. 대체 인덱스 {fallback_index}번 재시도.")
            self.cap = cv2.VideoCapture(fallback_index, cv2.CAP_V4L2)
            if not self.cap.isOpened():
                self.get_logger().error("❌ 사용 가능한 웹캠 장치를 찾을 수 없습니다.")
                raise RuntimeError("카메라 로드 실패")
        
        self.get_logger().info("✅ 웹캠 장치가 성공적으로 로드되었습니다.")

        # Real-time 단일 제어 루프 타이머 가동 (33ms)
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
        if current < target: return min(target, current + step)
        elif current > target: return max(target, current - step)
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
            print(f"[EXC] _show_frame 내부 예외 발생: {e}", file=sys.stderr, flush=True)
            self.enable_gui = False

    def camera_loop(self):
        print("[TRACK] 1. cap.read() 호출 직전", flush=True)
        ret, frame = self.cap.read()
        if not ret:
            print("[TRACK] 1-FAIL. 프레임 획득 실패", flush=True)
            return

        print("[TRACK] 2. cvtColor 호출 직전", flush=True)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        print("[TRACK] 3. detectMarkers 호출 직전", flush=True)
        if self.use_new_aruco:
            corners, ids, _ = self.aruco_detector.detectMarkers(gray)
        else:
            corners, ids, _ = cv2.aruco.detectMarkers(gray, self.aruco_dict, parameters=self.aruco_params)
        
        print("[TRACK] 4. 상태 표시 및 알고리즘 진입 직전", flush=True)

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
                                f"🔒 [타깃 락 완료] X:{self.tgt_x:.1f} Y:{self.tgt_y:.1f} θ:{math.degrees(self.tgt_theta):.1f}°")

        if self.tgt_locked and robot_x is not None:
            if not self.parking_sequence_started:
                mode_msg = String()
                mode_msg.data = "PARKING"
                self.robot_mode_pub.publish(mode_msg)
                self.parking_sequence_started = True
                self.get_logger().warn("🎯 마커 2개 동시 감지 성공! 라인트레이서 제어권을 회수하고 정밀 비전 주차를 시작합니다.")

        wp_x = None
        if self.tgt_locked:
            tx, ty, tth = int(self.tgt_x), int(self.tgt_y), self.tgt_theta

            # 1. 주차 마커 화살표 방향을 반대로 변경 (-)
            gx = int(tx - 50 * math.cos(tth))
            gy = int(ty - 50 * math.sin(tth))
            cv2.arrowedLine(frame, (tx, ty), (gx, gy), (0, 255, 0), 2, tipLength=0.25)

            cos_t = math.cos(tth)
            sin_t = math.sin(tth)
            p1_x, p1_y = int(tx - 1000 * cos_t), int(ty - 1000 * sin_t)
            p2_x, p2_y = int(tx + 1000 * cos_t), int(ty + 1000 * sin_t)
            cv2.line(frame, (p1_x, p1_y), (255, 255, 0), 1)

            # 2. 진입 게이트(WP) 위치를 반대로 변경 (-)
            wp_x = self.tgt_x - self.WAYPOINT_OFFSET * cos_t
            wp_y = self.tgt_y - self.WAYPOINT_OFFSET * sin_t
            
            cv2.circle(frame, (int(wp_x), int(wp_y)), 8, (0, 165, 255), -1)
            cv2.putText(frame, "Gate (WP)", (int(wp_x) + 12, int(wp_y) + 5), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 165, 255), 2)

        target_lin = 0.0
        target_ang = 0.0

        if robot_x is not None and self.tgt_locked and wp_x is not None:
            dx = self.tgt_x - robot_x
            dy = self.tgt_y - robot_y
            dist = math.sqrt(dx**2 + dy**2)

            dw_x = wp_x - robot_x
            dw_y = wp_y - robot_y
            dist_to_wp = math.sqrt(dw_x**2 + dw_y**2)

            if self.initial_dist is None:
                self.initial_dist = dist
                self.get_logger().warn(f"📏 [주차 초기거리 기록] {self.initial_dist:.1f}px")

            e_lat = -dx * math.sin(self.tgt_theta) + dy * math.cos(self.tgt_theta)
            e_head = math.atan2(math.sin(self.tgt_theta - robot_theta), 
                                math.cos(self.tgt_theta - robot_theta))

            # 현재 단계에 따른 조향 제어 오차 매핑
            theta_to_wp = math.atan2(dw_y, dw_x)
            e_wp = math.atan2(math.sin(theta_to_wp - (robot_theta + math.pi)), 
                              math.cos(theta_to_wp - (robot_theta + math.pi)))
            current_steering_err = e_head if self.state == 2 else e_wp

            # ── [자가 보정 슈퍼바이저 감시 레이어 (임계 시간 0.5초로 고속 패치)] ──
            if self.state in [1, 3]:
                if self.prev_dist is not None:
                    if dist > self.prev_dist + 0.1:
                        self.linear_mismatch_timer += 0.033
                        if self.linear_mismatch_timer >= 0.5:
                            self.linear_multiplier *= -1.0
                            self.get_logger().error(f"⚠️ [비상 반전 교정] 전후진 방향 역전 배율 적용: {self.linear_multiplier}")
                            self.linear_mismatch_timer = 0.0
                    else:
                        self.linear_mismatch_timer = max(0.0, self.linear_mismatch_timer - 0.1)
                self.prev_dist = dist
            else:
                self.prev_dist = None
                self.linear_mismatch_timer = 0.0

            if self.state in [1, 2]:
                if self.prev_err is not None:
                    if abs(current_steering_err) > abs(self.prev_err) + math.radians(0.15):
                        self.angular_mismatch_timer += 0.033
                        if self.angular_mismatch_timer >= 0.5:
                            self.angular_multiplier *= -1.0
                            self.get_logger().error(f"⚠️ [조향 반전 교정] 좌우 회전 방향 역전 배율 적용: {self.angular_multiplier}")
                            self.angular_mismatch_timer = 0.0
                    else:
                        self.angular_mismatch_timer = max(0.0, self.angular_mismatch_timer - 0.1)
                self.prev_err = current_steering_err
            else:
                self.prev_err = None
                self.angular_mismatch_timer = 0.0

            # ── [상태머신 페이즈 제어: 확정 후진 구조] ──
            if self.state == 1:
                if dist_to_wp <= self.WAYPOINT_THRESHOLD:
                    self.state = 2
                    self.get_logger().warn(f"🚨 [STATE 1→2] 진입 게이트 도달 완료 ({dist_to_wp:.1f}px). 정렬 페이즈 전환.")
                else:
                    # 🔥 [패치] 가출 차단을 위해 무조건 확정 후진 신호 할당
                    target_lin = -self.LINEAR_SPEED
                    
                    # 후진 기반 조향값 연산 (물리 조향 부호 보정 적용)
                    raw_ang = self.KP_X * e_wp
                    if abs(raw_ang) < self.MIN_ANGULAR_Z:
                        raw_ang = 0.0
                    target_ang = max(-self.MAX_ANGULAR_Z, min(self.MAX_ANGULAR_Z, raw_ang))

                    self.get_logger().info(
                        f"⬇️ [STATE 1: 게이트추적] WP거리:{dist_to_wp:.1f}px | 마커거리:{dist:.1f}px | Ang:{target_ang:+.3f}",
                        throttle_duration_sec=0.5)

            elif self.state == 2:
                target_lin = 0.0
                if abs(e_head) <= self.HEADING_THRESHOLD:
                    self.state = 3
                    self.get_logger().warn(f"✅ [STATE 2→3] 헤딩 정렬 동기화 완료 ({math.degrees(e_head):.1f}°). 직선 후진 도킹 기동.")
                else:
                    # 정렬 회전 (부호 방향성 매칭)
                    raw_ang = self.KP_HEADING * e_head
                    if abs(raw_ang) < self.MIN_ANGULAR_Z:
                        raw_ang = self.MIN_ANGULAR_Z * np.sign(raw_ang) if raw_ang != 0 else self.MIN_ANGULAR_Z
                    target_ang = max(-self.MAX_ANGULAR_Z, min(self.MAX_ANGULAR_Z, raw_ang))

                    self.get_logger().info(
                        f"🔄 [STATE 2: 헤딩정렬] 오차: {math.degrees(e_head):+.1f}° | e_lat:{e_lat:+.1f}px | Cmd_Ang:{target_ang:+.2f}",
                        throttle_duration_sec=0.4)

            elif self.state == 3:
                if dist > self.ARRIVE_THRESHOLD:
                    # 🔥 [패치] 최종 진입 기동 역시 부호 계산을 배제하고 무조건 확정 후진 적용
                    target_lin = -self.LINEAR_SPEED
                    target_ang = 0.0  
                    self.get_logger().info(
                        f"🚀 [STATE 3: 직선안착] 도킹 진입 중... 남은 제어거리: {dist:.1f}px",
                        throttle_duration_sec=0.4)
                else:
                    self.state = 4
                    mode_msg = String()
                    mode_msg.data = "PARKED"
                    self.robot_mode_pub.publish(mode_msg)
                    self.get_logger().warn(f"🏁 [주차 완료] 마커 전방 세팅 임계 영역({self.ARRIVE_THRESHOLD}px) 안착 성공!")

            elif self.state == 4:
                target_lin = 0.0
                target_ang = 0.0

        if not self.parking_sequence_started:
            print("[TRACK] 5-YIELD. 제어권 미회수 상태 (라인트레이서 제어 위임 중)", flush=True)
            self._show_frame(frame)
            return

        target_lin *= self.linear_multiplier
        target_ang *= self.angular_multiplier

        self.vel_lin = self._ramp(self.vel_lin, target_lin, 0.004)
        self.vel_ang = self._ramp(self.vel_ang, target_ang, 0.04)
        self._publish_vel(self.vel_lin, self.vel_ang)

        if self.batt_ok:
            col = (0, 0, 255) if self.batt_pct < 30 else (0, 255, 0)
            cv2.putText(frame, f"Batt: {self.batt_pct:.1f}% ({self.batt_v:.2f}V)", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
        else:
            cv2.putText(frame, "Batt: waiting...", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        if self.state == 1: state_name = "1:GATE_TRACK"
        elif self.state == 2: state_name = "2:HEADING_ALIGN"
        elif self.state == 3: state_name = "3:REVERSE_DOCK"
        else: state_name = "4:PARKED_DONE"

        state_str = f"STATE: {state_name}"
        if robot_x is not None and self.tgt_locked:
            state_str += f" | Lat:{e_lat:+.1f}px | Head:{math.degrees(e_head):+.1f}deg | Dist:{dist:.1f}px"
        cv2.putText(frame, state_str, (15, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 2)

        if not self.tgt_locked:
            n = len(self.tgt_samples_x)
            cv2.putText(frame, f"Stabilizing target {n}/{self.TARGET_LOCK_FRAMES}", (15, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 2)

        mult_str = f"L_mult:{self.linear_multiplier} | A_mult:{self.angular_multiplier}"
        cv2.putText(frame, mult_str, (15, frame.shape[0] - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)

        print("[TRACK] 5. _show_frame 호출 직전", flush=True)
        self._show_frame(frame)
        print("[TRACK] 6. 루프 정상 완료\n", flush=True)

    def emergency_stop(self):
        self.get_logger().info("🛑 [안전 시스템] 원격 강제 정지 및 비디오 인터페이스 해제")
        for _ in range(3):
            self._publish_vel(0.0, 0.0)
            time.sleep(0.1)
        if self.cap.isOpened():
            self.cap.release()
        cv2.destroyAllWindows()

def main(args=None):
    rclpy.init(args=args)
    node = CentralParkingController()
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