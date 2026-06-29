import sys
import cv2
import runpy
import time
import numpy as np
import multiprocessing
import queue
import threading
import _thread
from flask import Flask, Response

import rclpy
from rclpy.node import Node
from std_msgs.msg import Bool

# 카메라 번호 설정
CAM_FRONT = 4
CAM_WRIST = 6

MANAGED_INDICES = (CAM_FRONT, CAM_WRIST)

# 모델 경로 설정
MODEL_RED  = "ttingji/red_merge"
MODEL_BLUE = "ttingji/blue_merge"

# opoen cv 감지 설정
LOAD_HOLD_SEC       = 3.0   # 오른쪽 LOAD ROI 감지 유지 시간 (초)
CENTER_ON_SEC       = 5.0   # 가운데 하얀색 ON 전환 유지 시간 (초)
REQUIRED_STRIKES    = 60    # LOAD ROI 감지 프레임 수
OBJ_MIN_AREA        = 500   # 왼쪽 ROI 최소 감지 면적
OBJ_ABSENT_SEC  = 2.0 # 물체 감지 없음 타이머
OBJ_PRESENT_SEC = 2.0 # 물체 감지 있음 타이머

# ROS 2 통신 노드
class OmxStateNode(Node):
    def __init__(self, start_event, stop_event):
        super().__init__('omx_state_node')
        self.start_event = start_event
        self.stop_event  = stop_event

        self.loaded_pub   = self.create_publisher(Bool, '/vision/is_loaded',   10)
        self.obj_red_pub  = self.create_publisher(Bool, '/vision/object_red',  10)
        self.obj_blue_pub = self.create_publisher(Bool, '/vision/object_blue', 10)

        self.start_red_sub = self.create_subscription(
            Bool, '/vision/start_red',  self.start_red_callback,  10)
        self.start_blue_sub = self.create_subscription(
            Bool, '/vision/start_blue', self.start_blue_callback, 10)

        # ── LOAD ROI 상태
        self.is_loaded_locked  = False
        self.loaded_start_time = None

        # ── 가운데 하얀색 감지 상태
        self.center_white_state = False  # ON/OFF
        self.center_white_since = None   # ON 전환 타이머

        # ── 왼쪽 ROI 상태
        self.red_state         = True
        self.red_absent_since  = None
        self.red_present_since = None

        self.blue_state         = True
        self.blue_absent_since  = None
        self.blue_present_since = None

        self.obj_detection_active = True

        self.selected_model = None

        self.timer = self.create_timer(0.1, self._timer_republish)

        print("[노드 시작] 추론 제어 대기 중...")
        self._do_publish_loaded(False)
        self.obj_red_pub.publish(Bool(data=True))
        self.obj_blue_pub.publish(Bool(data=True))

    def _do_publish_loaded(self, val: bool):
        self.loaded_pub.publish(Bool(data=val))

    def _timer_republish(self):
        self._do_publish_loaded(self.is_loaded_locked)
        self.obj_red_pub.publish(Bool(data=self.red_state))
        self.obj_blue_pub.publish(Bool(data=self.blue_state))

    def start_red_callback(self, msg):
        if not msg.data:
            return
        print(" [RED] 추론 시작 신호 수신!")
        if not self.red_state or not self.blue_state:
            print("⛔ [RED] RED ROI에 물체 없음 → 추론 시작 거부")
            return
        print(f"✅ [RED] → 모델 {MODEL_RED} 으로 추론 시작")
        self.selected_model = MODEL_RED
        self._freeze_obj_detection()
        self.start_event.set()

    def start_blue_callback(self, msg):
        if not msg.data:
            return
        print(" [BLUE] 추론 시작 신호 수신!")
        if not self.blue_state:
            print("⛔ [BLUE] BLUE ROI에 물체 없음 → 추론 시작 거부")
            return
        print(f"✅ [BLUE] → 모델 {MODEL_BLUE} 으로 추론 시작")
        self.selected_model = MODEL_BLUE
        self._freeze_obj_detection()
        self.start_event.set()

    def _freeze_obj_detection(self):
        self.obj_detection_active = False
        print(f"[Detection] 상태 고정 → RED={self.red_state}, BLUE={self.blue_state}")

    def reset_loaded(self):
        self.is_loaded_locked      = False
        self.loaded_start_time     = None
        self.center_white_state    = False
        self.center_white_since    = None
        self._do_publish_loaded(False)
        print("[Loaded] 상태 리셋 → false")

    def enable_obj_detection(self):
        self.red_absent_since   = None
        self.red_present_since  = None
        self.blue_absent_since  = None
        self.blue_present_since = None
        self.obj_detection_active = True
        self.selected_model = None

    # LOAD ROI 판정 (2초 유지)
    def publish_loaded(self, is_loaded: bool):
        if self.is_loaded_locked:
            return
        if is_loaded:
            if self.loaded_start_time is None:
                self.loaded_start_time = time.time()
            elif time.time() - self.loaded_start_time >= LOAD_HOLD_SEC:
                self.is_loaded_locked = True
                self._do_publish_loaded(True)
                print("[Loaded] LOADED 확정 → true")
                self._check_stop_condition()
        else:
            self.loaded_start_time = None

    # 가운데 하얀색 판정
    def publish_center_white(self, raw: bool):
        now = time.time()
        if not self.center_white_state:
            # OFF → ON
            if raw:
                if self.center_white_since is None:
                    self.center_white_since = now
                elif now - self.center_white_since >= CENTER_ON_SEC:
                    self.center_white_state = True
                    self.center_white_since = None
                    print("센터 감지 → ON")
                    self._check_stop_condition()
            else:
                self.center_white_since = None
        else:
            # ON → OFF
            if not raw:
                self.center_white_state = False
                self.center_white_since = None
                print("센터 미감지 → OFF")

    # 추론 종료 조건
    def _check_stop_condition(self):
        if self.is_loaded_locked and self.center_white_state:
            if not self.stop_event.is_set():
                print("🛑 [종료 조건] LOADED + 가운데 하얀색 ON → 추론 종료!")
                self.stop_event.set()

    # 왼쪽 빨강 ROI
    def publish_red_detected(self, raw: bool):
        if not self.obj_detection_active:
            return
        now = time.time()
        if self.red_state:
            if not raw:
                if self.red_absent_since is None:
                    self.red_absent_since = now
                elif now - self.red_absent_since >= OBJ_ABSENT_SEC:
                    self.red_present_since = None
                    self.red_state = False
                    self.obj_red_pub.publish(Bool(data=False))
                    print("구급품 없음 → False")
            else:
                self.red_absent_since = None
        else:
            if raw:
                if self.red_present_since is None:
                    self.red_present_since = now
                elif now - self.red_present_since >= OBJ_PRESENT_SEC:
                    self.red_absent_since = None
                    self.red_state = True
                    self.obj_red_pub.publish(Bool(data=True))
                    print("구급품 감지 → True")
            else:
                self.red_present_since = None

    # 왼쪽 파랑 ROI
    def publish_blue_detected(self, raw: bool):
        if not self.obj_detection_active:
            return
        now = time.time()
        if self.blue_state:
            if not raw:
                if self.blue_absent_since is None:
                    self.blue_absent_since = now
                elif now - self.blue_absent_since >= OBJ_ABSENT_SEC:
                    self.blue_present_since = None
                    self.blue_state = False
                    self.obj_blue_pub.publish(Bool(data=False))
                    print("물 없음 → False")
            else:
                self.blue_absent_since = None
        else:
            if raw:
                if self.blue_present_since is None:
                    self.blue_present_since = now
                elif now - self.blue_present_since >= OBJ_PRESENT_SEC:
                    self.blue_absent_since = None
                    self.blue_state = True
                    self.obj_blue_pub.publish(Bool(data=True))
                    print("물 감지 2초 → True")
            else:
                self.blue_present_since = None


# Flask 웹 서버 프로세스

def flask_worker(queue_front, queue_wrist):
    app = Flask(__name__)

    @app.route('/')
    def index():
        return f'''
        <html>
          <head>
              <title>OMX Vision Debugger</title>
              <style>
                body {{ text-align: center; background-color: #222; color: white;
                       font-family: sans-serif; margin: 0; padding: 20px; }}
                .container {{ display: flex; justify-content: center; gap: 20px; margin-top: 20px; }}
                .cam-box {{ border: 2px solid #555; border-radius: 10px; padding: 10px;
                           background-color: #333; }}
                img {{ border: 1px solid #444; border-radius: 5px; }}
              </style>
          </head>
          <body>
            <h2>모방학습 모니터링</h2>
            <div class="container">
              <div class="cam-box">
                <h3>Front Camera (Index {CAM_FRONT})</h3>
                <img src="/video_feed/front" width="640" height="480">
              </div>
              <div class="cam-box">
                <h3>Wrist Camera (Index {CAM_WRIST})</h3>
                <img src="/video_feed/wrist" width="640" height="480">
              </div>
            </div>
          </body>
        </html>
        '''

    def generate_frames(frame_queue):
        while True:
            try:
                frame = frame_queue.get(timeout=0.1)
                encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 50]
                ret, buffer  = cv2.imencode('.jpg', frame, encode_param)
                if ret:
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n'
                           + buffer.tobytes() + b'\r\n')
            except queue.Empty:
                pass

    @app.route('/video_feed/front')
    def video_feed_front():
        return Response(generate_frames(queue_front),
                        mimetype='multipart/x-mixed-replace; boundary=frame')

    @app.route('/video_feed/wrist')
    def video_feed_wrist():
        return Response(generate_frames(queue_wrist),
                        mimetype='multipart/x-mixed-replace; boundary=frame')

    import logging
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=False)


# 전역 상태

global_queue_front = None
global_queue_wrist = None
global_ros_node    = None

_persistent_caps = {}
_persistent_lock = threading.Lock()

OriginalVideoCapture = cv2.VideoCapture


# 카메라 관리

def _get_or_open_cap(cam_index):
    with _persistent_lock:
        cap = _persistent_caps.get(cam_index)
        if cap is None or not cap.isOpened():
            cap = OriginalVideoCapture(cam_index)
            if not cap.isOpened():
                print(f"[Camera] ⚠️ 카메라 {cam_index} 오픈 실패!")
            else:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                cap.set(cv2.CAP_PROP_FPS, 30)
                print(f"[Camera] 카메라 {cam_index} 오픈 성공 ✅")
            _persistent_caps[cam_index] = cap
        return cap


# 색상 감지

def detect_red(hsv):
    m1 = cv2.inRange(hsv, np.array([0,   70, 50]), np.array([10,  255, 255]))
    m2 = cv2.inRange(hsv, np.array([170, 70, 50]), np.array([180, 255, 255]))
    return m1 | m2

def detect_blue(hsv):
    return cv2.inRange(hsv, np.array([100, 70, 50]), np.array([130, 255, 255]))

def detect_red_or_blue(hsv):
    return detect_red(hsv) | detect_blue(hsv)

def detect_white(hsv):
    """하얀색: 채도 낮고 명도 높음"""
    return cv2.inRange(hsv, np.array([0, 0, 200]), np.array([180, 40, 255]))

def get_max_area(frm, y1, y2, x1, x2, mask_fn):
    roi  = frm[y1:y2, x1:x2]
    hsv  = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mask = mask_fn(hsv)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0, None
    lc = max(contours, key=cv2.contourArea)
    return cv2.contourArea(lc), cv2.boundingRect(lc)


# 독립 카메라 읽기 스레드

_latest_frames = {CAM_FRONT: None, CAM_WRIST: None}
_frame_lock    = threading.Lock()

def _camera_reader_thread(cam_index, stop_flag: threading.Event):
    print(f"[CamThread] 카메라 {cam_index} 읽기 스레드 시작")
    frame_count       = 0
    loaded_strike     = 0
    WARMUP_FRAMES     = 60
    is_loaded_printed = False

    while not stop_flag.is_set():
        cap = _get_or_open_cap(cam_index)
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.05)
            continue

        if cam_index == CAM_FRONT:
            frame_count += 1
            debug_frame = frame.copy()

            r_roi_y1,  r_roi_y2  = 50,  240
            r_roi_x1,  r_roi_x2  = 440, 640
            lr_roi_y1, lr_roi_y2 = 200, 300
            lr_roi_x1, lr_roi_x2 = 30,  200
            lb_roi_y1, lb_roi_y2 = 90,  190
            lb_roi_x1, lb_roi_x2 = 30,  200
            c_roi_y1,  c_roi_y2  = 180, 210
            c_roi_x1,  c_roi_x2  = 260, 300

            # ROI 박스 그리기
            cv2.rectangle(debug_frame,
                          (r_roi_x1,  r_roi_y1),  (r_roi_x2,  r_roi_y2),  (255, 165, 0), 2)
            cv2.rectangle(debug_frame,
                          (lr_roi_x1, lr_roi_y1), (lr_roi_x2, lr_roi_y2), (0,   0,   255), 2)
            cv2.rectangle(debug_frame,
                          (lb_roi_x1, lb_roi_y1), (lb_roi_x2, lb_roi_y2), (255, 0,   0),   2)
            # ✅ 가운데 하얀색 ROI 박스
            cv2.rectangle(debug_frame,
                          (c_roi_x1, c_roi_y1), (c_roi_x2, c_roi_y2), (255, 255, 255), 2)

            # ROI 레이블 
            cv2.putText(debug_frame, "LOAD ROI",
                        (r_roi_x1  + 4, r_roi_y1  + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 165, 0), 1)
            cv2.putText(debug_frame, "RED ROI",
                        (lr_roi_x1 + 4, lr_roi_y1 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
            cv2.putText(debug_frame, "BLUE ROI",
                        (lb_roi_x1 + 4, lb_roi_y1 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 0, 0), 1)
            # 가운데 하얀색 ROI 레이블
            cv2.putText(debug_frame, "",
                        (c_roi_x1 + 4, c_roi_y1 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)

            if frame_count < WARMUP_FRAMES:
                if frame_count % 20 == 0:
                    print(f"[Vision] 워밍업 중... ({frame_count}/{WARMUP_FRAMES})")
                cv2.putText(debug_frame, "Warming Up...", (20, 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)
            else:
                # 오른쪽 LOAD ROI
                r_area, r_rect = get_max_area(
                    frame, r_roi_y1, r_roi_y2, r_roi_x1, r_roi_x2, detect_red_or_blue)
                if r_rect is not None:
                    rx, ry, rw, rh = r_rect
                    cv2.rectangle(debug_frame,
                                  (rx+r_roi_x1, ry+r_roi_y1),
                                  (rx+rw+r_roi_x1, ry+rh+r_roi_y1),
                                  (0, 165, 255), 2)

                if r_area > 900:
                    loaded_strike += 1
                else:
                    loaded_strike     = 0
                    is_loaded_printed = False

                if global_ros_node is not None and global_ros_node.is_loaded_locked:
                    cv2.putText(debug_frame, "LOADED", (r_roi_x1, 40),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                elif loaded_strike >= REQUIRED_STRIKES and not is_loaded_printed:
                    cv2.putText(debug_frame, "LOADED", (r_roi_x1, 40),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                    is_loaded_printed = True

                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_loaded(loaded_strike >= REQUIRED_STRIKES)
                    except Exception:
                        pass

                # 왼쪽 빨강 ROI
                lr_area, lr_rect = get_max_area(
                    frame, lr_roi_y1, lr_roi_y2, lr_roi_x1, lr_roi_x2, detect_red)
                if lr_rect is not None:
                    lrx, lry, lrw, lrh = lr_rect
                    cv2.rectangle(debug_frame,
                                  (lrx+lr_roi_x1, lry+lr_roi_y1),
                                  (lrx+lrw+lr_roi_x1, lry+lrh+lr_roi_y1),
                                  (0, 80, 255), 2)

                raw_red = lr_area > OBJ_MIN_AREA
                if global_ros_node is not None:
                    rc = (0, 255, 0) if global_ros_node.red_state else (100, 100, 255)
                    cv2.putText(debug_frame,
                                f"RED: {'ON' if global_ros_node.red_state else 'OFF'}",
                                (lr_roi_x1, lr_roi_y2 + 18),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, rc, 1)
                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_red_detected(raw_red)
                    except Exception:
                        pass

                # 왼쪽 파랑 ROI 
                lb_area, lb_rect = get_max_area(
                    frame, lb_roi_y1, lb_roi_y2, lb_roi_x1, lb_roi_x2, detect_blue)
                if lb_rect is not None:
                    lbx, lby, lbw, lbh = lb_rect
                    cv2.rectangle(debug_frame,
                                  (lbx+lb_roi_x1, lby+lb_roi_y1),
                                  (lbx+lbw+lb_roi_x1, lby+lbh+lb_roi_y1),
                                  (255, 80, 0), 2)

                raw_blue = lb_area > OBJ_MIN_AREA
                if global_ros_node is not None:
                    bc = (0, 255, 0) if global_ros_node.blue_state else (100, 100, 255)
                    cv2.putText(debug_frame,
                                f"BLUE: {'ON' if global_ros_node.blue_state else 'OFF'}",
                                (lb_roi_x1, lb_roi_y1 - 8),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, bc, 1)
                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_blue_detected(raw_blue)
                    except Exception:
                        pass

                # 가운데 하얀색 ROI
                cw_area, cw_rect = get_max_area(
                    frame, c_roi_y1, c_roi_y2, c_roi_x1, c_roi_x2, detect_white)

                if cw_rect is not None:
                    cwx, cwy, cww, cwh = cw_rect
                    cv2.rectangle(debug_frame,
                                  (cwx+c_roi_x1, cwy+c_roi_y1),
                                  (cwx+cww+c_roi_x1, cwy+cwh+c_roi_y1),
                                  (200, 200, 200), 2)

                raw_white = cw_area > 400
                if global_ros_node is not None:
                    wc = (0, 255, 0) if global_ros_node.center_white_state else (100, 100, 255)
                    cv2.putText(debug_frame,
                                f"CENTER: {'ON' if global_ros_node.center_white_state else 'OFF'}",
                                (c_roi_x1, c_roi_y2 + 18),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, wc, 1)

                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_center_white(raw_white)
                    except Exception:
                        pass

            if global_queue_front is not None:
                try:
                    global_queue_front.put_nowait(debug_frame)
                except queue.Full:
                    pass

            with _frame_lock:
                _latest_frames[CAM_FRONT] = frame.copy()

        elif cam_index == CAM_WRIST:
            if global_queue_wrist is not None:
                try:
                    global_queue_wrist.put_nowait(frame)
                except queue.Full:
                    pass
            with _frame_lock:
                _latest_frames[CAM_WRIST] = frame.copy()

    print(f"[CamThread] 카메라 {cam_index} 읽기 스레드 종료")


# HookedVideoCapture

class HookedVideoCapture:
    def __init__(self, *args, **kwargs):
        try:
            self.cam_index = int(args[0]) if args else None
        except (ValueError, TypeError):
            self.cam_index = None

        if self.cam_index not in MANAGED_INDICES:
            self._cap = OriginalVideoCapture(*args, **kwargs)
        else:
            self._cap = None

    def release(self):
        if self._cap:
            self._cap.release()

    def isOpened(self):
        if self.cam_index in MANAGED_INDICES:
            return _get_or_open_cap(self.cam_index).isOpened()
        return self._cap.isOpened() if self._cap else False

    def set(self, prop_id, value):
        if self.cam_index in MANAGED_INDICES:
            return _get_or_open_cap(self.cam_index).set(prop_id, value)
        return self._cap.set(prop_id, value) if self._cap else False

    def get(self, prop_id):
        if self.cam_index in MANAGED_INDICES:
            return _get_or_open_cap(self.cam_index).get(prop_id)
        return self._cap.get(prop_id) if self._cap else 0

    def grab(self):
        if self.cam_index in MANAGED_INDICES:
            return True
        return self._cap.grab() if self._cap else False

    def retrieve(self, *args, **kwargs):
        if self.cam_index in MANAGED_INDICES:
            with _frame_lock:
                f = _latest_frames.get(self.cam_index)
            return (True, f.copy()) if f is not None else (False, None)
        return self._cap.retrieve(*args, **kwargs) if self._cap else (False, None)

    def read(self, *args, **kwargs):
        if self.cam_index in MANAGED_INDICES:
            with _frame_lock:
                f = _latest_frames.get(self.cam_index)
            if f is not None:
                return True, f.copy()
            cap = _get_or_open_cap(self.cam_index)
            return cap.read(*args, **kwargs)
        return self._cap.read(*args, **kwargs) if self._cap else (False, None)


cv2.VideoCapture = HookedVideoCapture


def stop_watchdog(stop_event):
    stop_event.wait()
    print("\n[Watchdog] stop_event 감지 → 추론 루프 종료")
    _thread.interrupt_main()


# 메인 실행부

if __name__ == "__main__":
    rclpy.init()
    start_event = threading.Event()
    stop_event  = threading.Event()

    global_ros_node = OmxStateNode(start_event, stop_event)
    threading.Thread(target=rclpy.spin, args=(global_ros_node,), daemon=True).start()

    global_queue_front = multiprocessing.Queue(maxsize=2)
    global_queue_wrist = multiprocessing.Queue(maxsize=2)

    flask_process = multiprocessing.Process(
        target=flask_worker,
        args=(global_queue_front, global_queue_wrist),
        daemon=True
    )
    flask_process.start()

    print("[Camera] 카메라 사전 오픈 중...")
    _get_or_open_cap(CAM_FRONT)
    _get_or_open_cap(CAM_WRIST)

    cam_stop_flag = threading.Event()
    threading.Thread(target=_camera_reader_thread, args=(CAM_FRONT, cam_stop_flag), daemon=True).start()
    threading.Thread(target=_camera_reader_thread, args=(CAM_WRIST, cam_stop_flag), daemon=True).start()
    print("[Camera] 카메라 읽기 스레드 시작 \n")

    BASE_ARGV = [
        "robot_client",
        "--robot.type=omx_follower",
        "--robot.port=/dev/omx_follower",
        f'--robot.cameras={{"front": {{"type": "opencv", "index_or_path": {CAM_WRIST},'
        f' "width": 640, "height": 480, "fps": 30}},'
        f' "wrist": {{"type": "opencv", "index_or_path": {CAM_FRONT},'
        f' "width": 640, "height": 480, "fps": 30}}}}',
        "--robot.id=omx_follower_arm",
        "--task=Pick up Doll",
        "--policy_type=act",
        "--policy_device=cuda",
        "--client_device=cpu",
        "--server_address=10.10.14.63:5432",
        "--fps=24",
        "--actions_per_chunk=100",
        "--chunk_size_threshold=0.6",
        "--aggregate_fn_name=weighted_average",
    ]

    print(f"🚀 Flask 서버 및 ROS 2 노드 시작 (CAM_FRONT={CAM_FRONT}, CAM_WRIST={CAM_WRIST})")
    print("PC 브라우저 접속: http://10.10.14.24:5000")
    print("추론 종료 조건: LOADED AND 가운데 하얀색 ON\n")

    while True:
        print("⏳ [대기] 추론 시작 신호를 기다립니다...")
        print("   → ros2 topic pub --once /vision/start_red  std_msgs/msg/Bool \"data: true\"")
        print("   → ros2 topic pub --once /vision/start_blue std_msgs/msg/Bool \"data: true\"\n")
        start_event.wait()
        start_event.clear()
        stop_event.clear()

        selected = global_ros_node.selected_model or MODEL_RED
        sys.argv = BASE_ARGV + [f"--pretrained_name_or_path={selected}"]

        global_ros_node.reset_loaded()

        watchdog = threading.Thread(target=stop_watchdog, args=(stop_event,), daemon=True)
        watchdog.start()

        print("🚀 [시작] 추론 루프를 시작합니다.")
        try:
            runpy.run_module("lerobot.async_inference.robot_client", run_name="__main__")
        except KeyboardInterrupt:
            print("\n 추론 종료됨. 다시 신호를 기다립니다.")
        except Exception as e:
            print(f"오류: {e}")

        global_ros_node.enable_obj_detection()