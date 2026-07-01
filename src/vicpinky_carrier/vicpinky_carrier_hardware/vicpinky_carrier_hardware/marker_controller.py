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
from rclpy.action import ActionServer
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from geometry_msgs.msg import TwistStamped  
# from std_msgs.msg import String             
# from std_srvs.srv import Trigger
# from turtlebot_state_msgs.msg import VicpinkySignal
# from turtlebot_state_msgs.msg import RobotState
from vicpinky_carrier_interfaces.action import MarkerTrace

class CentralParkingController(Node):
    def __init__(self):
        super().__init__('central_parking_only')
        qos = QoSProfile(depth=10)
        
        # ── 1. ROS 2 파라미터 선언 ──
        # self.declare_parameter('parking_id', 13)           
        # self.declare_parameter('robot_id', 14)              
        self.declare_parameter('camera_index', 6)          
        # self.declare_parameter('robot_namespace', '')      

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
        self.declare_parameter('park_dist_threshold_px', 40.0)
        
        self.declare_parameter('target_lock_frames', 20)   
        self.declare_parameter('theta_filter_len', 10)     
        self.declare_parameter('enable_gui', False)       
        self.declare_parameter('camera_rotate_ccw90', True)  # 카메라 90도 반시계 보정 on/off


        # 파라미터 값 인스턴스 변수 매핑
        # self.parking_id = self.get_parameter('parking_id').value
        # self.robot_id = self.get_parameter('robot_id').value
        self.camera_index = self.get_parameter('camera_index').value
        # self.robot_ns = self.get_parameter('robot_namespace').value
        # self.robot_ns = self.get_parameter('robot_namespace').value

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
        
        # ── 2. 상태머신 및 제어권 스위칭 변수 초기화 ──
        self.current_robot = None
        self.current_goal = None
        self.goal_index = None
        self.is_action_running = None
        # self.start_parking = True # False
        self.load_seq = 0
        robot_namespaces = ['tb3_01', 'tb3_02', 'tb3_03', 'tb3_04']
        self.robot_id_list = [1, 2, 3, 4]  
        self.spot_id_list = [11, 12, 13, 14, 15]  

        # self.tb3_01_stage = None
        # self.tb3_02_stage = None
        # self.tb3_03_stage = None
        # self.tb3_04_stage = 'PARKING'

        self.state = 1
        self.chase_marker_start = False
        self.parking_sequence_started = False  
        self.initial_dist = None

        self.is_arrived = False   # 목적지 근처에 도달했는가?
        self.is_aligned = False   # 도착 후 엉덩이 방향(헤딩)을 마커와 똑같이 맞췄는가?

        self.vel_lin = 0.0
        self.vel_ang = 0.0

        # # ── 3. 자가 보정 슈퍼바이저 변수 ──
        self.prev_dist = None               
        self.prev_err = None             
        self.linear_mismatch_timer = 0.0    
        self.angular_mismatch_timer = 0.0   
        self.linear_multiplier = 1.0
        self.angular_multiplier = 1.0

        # ── 4. 데이터 필터링용 버퍼 (deque) 생성 ──
        self.tgt_locked = False
        self.tgt_x = [None] * 5
        self.tgt_y = [None] * 5
        self.tgt_theta = [None] * 5 
        self.theta_buf = deque(maxlen=self.THETA_FILTER_LEN)

        # ── 5. ROS 2 토픽 통신 설정 ──
        self.timer_cb_group = MutuallyExclusiveCallbackGroup()
        self.action_cb_group = MutuallyExclusiveCallbackGroup()

        self.cmd_vel_pub = []
        # self.robot_mode_pub = []
        for ns in robot_namespaces: # cmd_vel 토픽 퍼블리셔 생성
            cmd_topic = f'/{ns}/cmd_vel' 
            # sgn_topic = f'/{ns}/vicpinky_signal' 
            self.cmd_vel_pub.append(self.create_publisher(TwistStamped, cmd_topic, qos))
            # self.robot_mode_pub.append(self.create_publisher(VicpinkySignal, sgn_topic, qos))
        self._robot_action = ActionServer(
            self, MarkerTrace, "marker_trace", self.excute_callback, callback_group=self.action_cb_group
        )

        # ros2 service call /start_parking std_srvs/srv/Trigger "{}" # 서비스 사용방법
        # self.start_parking_service = self.create_service(Trigger, '/start_parking', self._start_parking_callback)

        # self.get_logger().info(f"📢 [{self.robot_ns if self.robot_ns else 'Global'}] v6.7 주차제어 시스템 초기화 완료 )")

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
            fallback_index = 0 if self.camera_index == 2 else 2
            self.get_logger().warn(f"⚠️ 카메라 인덱스 {self.camera_index}번 실패. 대체 인덱스 {fallback_index}번 재시도.")
            self.cap = cv2.VideoCapture(fallback_index, cv2.CAP_V4L2)
            if not self.cap.isOpened():
                self.get_logger().error("❌ 사용 가능한 웹캠 장치를 찾을 수 없습니다.")
                raise RuntimeError("카메라 로드 실패")
        
        self.get_logger().info("✅ 웹캠 장치가 성공적으로 로드되었습니다.")

        # Real-time 단일 제어 루프 타이머 가동 (33ms)
        self.create_timer(0.033, self.camera_loop, callback_group=self.timer_cb_group)

    def _publish_vel(self, lin, ang):
        msg = TwistStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'base_link'
        msg.twist.linear.x = lin
        msg.twist.angular.z = ang
        if self.current_robot is not None:
            self.cmd_vel_pub[self.current_robot-1].publish(msg)

    # def _start_parking_callback(self, request, response):
    #     self.get_logger().info("⚡ Change to Parking Mode.")
    #     self.start_parking = True

    #     # 4. 신호를 보낸 쪽에 "성공적으로 모드가 변경되었다"고 응답을 보냄
    #     response.success = True
    #     response.message = "Mode changed to Parking!"
    #     return response

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
            cv2.imshow(f"Parking Monitor [Global]", frame)
            cv2.waitKey(1)
        except Exception as e:
            print(f"[EXC] _show_frame 내부 예외 발생: {e}", file=sys.stderr, flush=True)
            self.enable_gui = False

    def _fix_marker(self, cx, cy, th, mid):
        i=self.spot_id_list.index(mid)
        self.tgt_x[i] = cx
        self.tgt_y[i] = cy
        self.tgt_theta[i] = th
        # if self.tgt_x[4] is not None and self.tgt_x[3] is not None and self.tgt_x[2] is not None and self.tgt_x[0] is not None:
        if self.tgt_x[4] is not None and self.tgt_x[3] is not None and self.tgt_x[2] is not None and self.tgt_x[0] is not None:
            self.tgt_locked = True
            self.get_logger().info(f"🔒 [All targets locked] : {self.tgt_x[2]}")

    # ros2 action send_goal /marker_trace vicpinky_carrier_interfaces/action/MarkerTrace "{bot_num: 1, bot_action: 'Park'}"
    def excute_callback(self, goal_handle):
        result = MarkerTrace.Result()
        self.action_robot=goal_handle.request.bot_num
        self.current_action=goal_handle.request.bot_action
        if self.current_action in ['Park', 'P']:
            self.action_goal = 'P'
        elif self.current_action in ['Load', 'L']:
            self.action_goal = 'L'
        else:
            self.action_goal = None

        if not self.tgt_locked:
            self.get_logger().warn('Initialization is not complete.')
            goal_handle.abort()
            result.success = False
            result.action_result = 'Initialization is not complete.'
            return result
        if self.action_goal == None or not self.action_robot in self.robot_id_list:
            self.get_logger().warn('Wrong action input. bot_num : [1, 3, 4], bot_action : [Park/Load]')
            goal_handle.abort()
            result.success = False
            result.action_result = 'Invalid action command.'
            return result
        
        self.is_action_running = True
        feedback_msg = MarkerTrace.Feedback()
        loop_rate = self.create_rate(10.0)
        try:
            while(True):
                feedback_msg.current_state = f"터틀봇 인식 : {self.chase_marker_start}, 현재 단계 : {self.state}"
                goal_handle.publish_feedback(feedback_msg)
                if self.state == 4:
                    if self.action_goal == 'L' and self.load_seq == 0:
                        self.state = 1
                        self.current_goal = None
                        self.load_seq = 1
                    else :
                        # mode_msg = VicpinkySignal()
                        # mode_msg.signal = "DONE"
                        # mode_msg.stamp = self.get_clock().now().to_msg()
                        # self.robot_mode_pub[self.current_robot-1].publish(mode_msg)
                        # self.tb3_01_stage = ""
                        # self.tb3_02_stage = ""
                        # self.tb3_03_stage = ""
                        # self.tb3_04_stage = ""
                        self.load_seq = 0
                        self.state = 1
                        self.chase_marker_start = False
                        self.current_robot = None
                        self.current_goal = None
                        self.goal_index = None
                        break
                loop_rate.sleep()
            goal_handle.succeed()
            result.success = True
            result.action_result = f'Successfully moved turtlebot'
            return result
        finally:
            self.is_action_running = False
            self.action_robot=None
            self.current_action=None

    # 메인 알고리즘
    def camera_loop(self):
        # print("[TRACK] 1. cap.read() 호출 직전", flush=True)
        ret, frame = self.cap.read()
        if not ret:
            print("[TRACK] 1-FAIL. 프레임 획득 실패", flush=True)
            return
        
        # 카메라 90도 반시계 보정 (기준 좌표계 정렬)
        if self.rotate_ccw90:
            frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)

        # print("[TRACK] 2. cvtColor 호출 직전", flush=True)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # print("[TRACK] 3. detectMarkers 호출 직전", flush=True)
        if self.use_new_aruco:
            corners, ids, _ = self.aruco_detector.detectMarkers(gray)
        else:
            corners, ids, _ = cv2.aruco.detectMarkers(gray, self.aruco_dict, parameters=self.aruco_params)
        
        # print("[TRACK] 4. 상태 표시 및 알고리즘 진입 직전", flush=True)

        robot_x = robot_y = robot_theta = None

        if ids is not None:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            id_list = ids.flatten().tolist()
                        
            for i, mid in enumerate(id_list):
                cx, cy, th = self._marker_center_theta(corners[i])
                if mid in self.robot_id_list and self.is_action_running:
                    if mid == self.action_robot:
                        self.current_robot = mid
                if self.current_robot == mid:
                    robot_x = int(cx)
                    robot_y = int(cy)
                    self.theta_buf.append(th)
                    robot_theta = float(np.mean(self.theta_buf))

                    # 로봇 후방 헤딩 방향 표시 (적색 화살표)
                    ax = int(cx - 45 * math.cos(robot_theta))
                    ay = int(cy - 45 * math.sin(robot_theta))
                    cv2.arrowedLine(frame, (robot_x, robot_y), (ax, ay), (0, 0, 255), 2, tipLength=0.3)
                if mid in self.spot_id_list and not self.tgt_locked:
                    self._fix_marker(cx, cy, th, mid)

        if self.current_robot is not None:
            if not self.chase_marker_start:
                # mode_msg = VicpinkySignal()
                # mode_msg.signal = "PARK" if self.start_parking else "LOAD"
                # mode_msg.stamp = self.get_clock().now().to_msg()
                # self.robot_mode_pub[self.current_robot-1].publish(mode_msg)
                self.chase_marker_start = True
                self.get_logger().info(f"🎯 마커 감지 성공! 정밀 비전 제어를 시작합니다.")

        wp_x = None
        #  그러니까 여기부터 제어 시작인거고 잘 바꿔보자
        if self.is_action_running:
            if self.current_robot is not None:
                if self.action_goal == 'P':
                    self.current_goal = self.current_robot + 10
                elif self.load_seq == 0:
                    self.current_goal = 15
                elif self.load_seq == 1:
                    self.current_goal = 13
            if self.current_goal is not None:
                self.goal_index = self.spot_id_list.index(self.current_goal)

            if self.tgt_locked and self.current_goal is not None:
                tx, ty, tth = int(self.tgt_x[self.goal_index]), int(self.tgt_y[self.goal_index]), self.tgt_theta[self.goal_index]
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
                wp_x = tx - self.WAYPOINT_OFFSET * cos_t
                wp_y = ty - self.WAYPOINT_OFFSET * sin_t
                cv2.circle(frame, (int(wp_x), int(wp_y)), 8, (0, 165, 255), -1)
                cv2.putText(frame, "Gate (WP)", (int(wp_x) + 12, int(wp_y) + 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 165, 255), 2)

            target_lin = 0.0
            target_ang = 0.0
            e_lat = 0.0
            e_head = 0.0
            dist = 0.0

            if self.current_robot is not None and robot_x is not None and self.current_goal is not None and self.tgt_locked and wp_x is not None:
                dx = self.tgt_x[self.goal_index] - robot_x
                dy = self.tgt_y[self.goal_index] - robot_y
                dist = math.sqrt(dx ** 2 + dy ** 2)

                dw_x = wp_x - robot_x
                dw_y = wp_y - robot_y
                dist_to_wp = math.sqrt(dw_x ** 2 + dw_y ** 2)

                if self.initial_dist is None:
                    self.initial_dist = dist
                    self.get_logger().warn(f"📏 [초기거리] {self.initial_dist:.1f}px")

                e_lat = -dx * math.sin(self.tgt_theta[self.goal_index]) + dy * math.cos(self.tgt_theta[self.goal_index])
                e_head = math.atan2(math.sin(self.tgt_theta[self.goal_index] - robot_theta),
                                    math.cos(self.tgt_theta[self.goal_index] - robot_theta))

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

                elif self.state == 4:
                    target_lin = 0.0
                    target_ang = 0.0

            if not self.chase_marker_start:
                print("[TRACK] 5-YIELD. 제어권 미회수 상태 (라인트레이서 제어 위임 중)", flush=True)
                self._show_frame(frame)
                return

            self.vel_lin = self._ramp(self.vel_lin, target_lin, 0.004)
            self.vel_ang = self._ramp(self.vel_ang, target_ang, 0.04)
            self._publish_vel(self.vel_lin, self.vel_ang)

        if self.state == 1: state_name = "1:GATE_TRACK"
        elif self.state == 2: state_name = "2:HEADING_ALIGN"
        elif self.state == 3: state_name = "3:REVERSE_DOCK"
        else: state_name = "4:PARKED_DONE"

        state_str = f"STATE: {state_name}"
        if robot_x is not None and self.tgt_locked:
            state_str += f" | Lat:{e_lat:+.1f}px | Head:{math.degrees(e_head):+.1f}deg | Dist:{dist:.1f}px"
        cv2.putText(frame, state_str, (15, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 2)

        mult_str = f"L_mult:{self.linear_multiplier} | A_mult:{self.angular_multiplier}"
        cv2.putText(frame, mult_str, (15, frame.shape[0] - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)

        # if self.state == 4:
        #     if not self.start_parking and self.load_seq == 0:
        #         self.state = 1
        #         self.current_goal = None
        #         self.load_seq = 1
        #     else :
        #         mode_msg = VicpinkySignal()
        #         mode_msg.signal = "DONE"
        #         mode_msg.stamp = self.get_clock().now().to_msg()
        #         # self.robot_mode_pub[self.current_robot-1].publish(mode_msg)
        #         # self.tb3_01_stage = ""
        #         # self.tb3_02_stage = ""
        #         # self.tb3_03_stage = ""
        #         # self.tb3_04_stage = ""
        #         self.load_seq = 0
        #         self.state = 1
        #         self.chase_marker_start = False
        #         self.current_robot = None
        #         self.current_goal = None
        #         self.goal_index = None

        # print("[TRACK] 5. _show_frame 호출 직전", flush=True)
        self._show_frame(frame)
        print(f"[TRACK] 6. 루프 정상 완료 {self.current_goal, self.goal_index}", flush=True)

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

    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
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