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

# ==========================================
#  ROS 2 통신 노드
# ==========================================
class OmxStateNode(Node):
    def __init__(self, start_event, stop_event):
        super().__init__('omx_state_node')
        self.start_event = start_event
        self.stop_event  = stop_event
 
        # 퍼블리셔 3개
        self.loaded_pub     = self.create_publisher(Bool, '/vision/is_loaded',   10)
        self.obj_red_pub    = self.create_publisher(Bool, '/vision/object_red',  10)
        self.obj_blue_pub   = self.create_publisher(Bool, '/vision/object_blue', 10)
 
        self.start_sub = self.create_subscription(
            Bool, '/vision/start_inference', self.start_callback, 10)
 
        # ── LOAD ROI 상태
        self.is_loaded_locked  = False
        self.loaded_start_time = None
 
        # ── 빨강 ROI 상태
        self.red_state         = True
        self.red_absent_since  = None
        self.red_present_since = None
 
        # ── 파랑 ROI 상태
        self.blue_state         = True
        self.blue_absent_since  = None
        self.blue_present_since = None
 
        self.obj_detection_active = True

        self.OBJ_ABSENT_SEC  = 20.0
        self.OBJ_PRESENT_SEC =  5.0


        print("🚀 [노드 시작] 추론 제어 대기 중...")
        self._do_publish_loaded(False)
        self.obj_red_pub.publish(Bool(data=True))
        self.obj_blue_pub.publish(Bool(data=True))

    def _do_publish_loaded(self, val: bool):
        self.loaded_pub.publish(Bool(data=val))

    def _timer_republish(self):
        self._do_publish_loaded(self.is_loaded_locked)
        self.obj_red_pub.publish(Bool(data=self.red_state))
        self.obj_blue_pub.publish(Bool(data=self.blue_state))

    def start_callback(self, msg):
        if msg.data:
            print("🔥 추론 시작 신호 수신!")
            # 빨강 또는 파랑 둘 중 하나라도 감지되면 시작 허용
            if self.red_state or self.blue_state:
                print("✅ 물체 감지 확인 → 추론 시작")
                self.start_event.set()
            else:
                print("⛔ 두 ROI 모두 물체 없음 → 추론 시작 거부")

    def reset_loaded(self):
        self.is_loaded_locked  = False
        self.loaded_start_time = None
        self._do_publish_loaded(False)
        print("[Loaded] 상태 리셋 → false")

    def enable_obj_detection(self):
        self.red_absent_since   = None
        self.red_present_since  = None
        self.blue_absent_since  = None
        self.blue_present_since = None
        self.obj_detection_active = True

    def publish_loaded(self, is_loaded: bool):
        if self.is_loaded_locked:
            return
        if is_loaded:
            if self.loaded_start_time is None:
                self.loaded_start_time = time.time()
            elif time.time() - self.loaded_start_time >= 5.0:
                self.is_loaded_locked = True
                self._do_publish_loaded(True)
                if not self.stop_event.is_set():
                    print("⚠️ LOADED 완료! 추론을 정지합니다.")
                    self.stop_event.set()
        else:
            self.loaded_start_time = None

     # ── 빨강 ROI 판정 ───────────────────────────────────────────────
    def publish_red_detected(self, raw: bool):
        if not self.obj_detection_active:
            return
        now = time.time()
        if self.red_state:
            if not raw:
                if self.red_absent_since is None:
                    self.red_absent_since = now
                elif now - self.red_absent_since >= self.OBJ_ABSENT_SEC:
                    self.red_present_since = None
                    self.red_state = False
                    self.obj_red_pub.publish(Bool(data=False))
                    print("[RedROI] 물체 없음 20초 → False")
            else:
                self.red_absent_since = None
        else:
            if raw:
                if self.red_present_since is None:
                    self.red_present_since = now
                elif now - self.red_present_since >= self.OBJ_PRESENT_SEC:
                    self.red_absent_since = None
                    self.red_state = True
                    self.obj_red_pub.publish(Bool(data=True))
                    print("[RedROI] 물체 감지 5초 → True")
            else:
                self.red_present_since = None
 
    # ── 파랑 ROI 판정 ───────────────────────────────────────────────
    def publish_blue_detected(self, raw: bool):
        if not self.obj_detection_active:
            return
        now = time.time()
        if self.blue_state:
            if not raw:
                if self.blue_absent_since is None:
                    self.blue_absent_since = now
                elif now - self.blue_absent_since >= self.OBJ_ABSENT_SEC:
                    self.blue_present_since = None
                    self.blue_state = False
                    self.obj_blue_pub.publish(Bool(data=False))
                    print("[BlueROI] 물체 없음 20초 → False")
            else:
                self.blue_absent_since = None
        else:
            if raw:
                if self.blue_present_since is None:
                    self.blue_present_since = now
                elif now - self.blue_present_since >= self.OBJ_PRESENT_SEC:
                    self.blue_absent_since = None
                    self.blue_state = True
                    self.obj_blue_pub.publish(Bool(data=True))
                    print("[BlueROI] 물체 감지 5초 → True")
            else:
                self.blue_present_since = None


# ==========================================
# Flask 웹 서버 프로세스
# ==========================================
def flask_worker(queue_front, queue_wrist):
    app = Flask(__name__)
 
    @app.route('/')
    def index():
        return '''
        <html>
          <head>
              <title>OMX Vision Debugger</title>
              <style>
                body { text-align: center; background-color: #222; color: white;
                       font-family: sans-serif; margin: 0; padding: 20px; }
                .container { display: flex; justify-content: center; gap: 20px; margin-top: 20px; }
                .cam-box { border: 2px solid #555; border-radius: 10px; padding: 10px;
                           background-color: #333; }
                img { border: 1px solid #444; border-radius: 5px; }
              </style>
          </head>
          <body>
            <h2>모방학습 초경량 듀얼 비전 모니터링 (No Latency)</h2>
            <div class="container">
              <div class="cam-box">
                <h3>Front Camera (Index 5)</h3>
                <img src="/video_feed/front" width="640" height="480">
              </div>
              <div class="cam-box">
                <h3>Wrist Camera (Index 6)</h3>
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


# ==========================================
# 전역 상태
# ==========================================
global_queue_front = None
global_queue_wrist = None
global_ros_node    = None

_persistent_caps = {}
_persistent_lock = threading.Lock()
MANAGED_INDICES  = (5, 6)

OriginalVideoCapture = cv2.VideoCapture


# ==========================================
# 카메라 관리
# ==========================================
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

# ==========================================
# 색상 감지
# ==========================================
def detect_red(hsv):
    m1 = cv2.inRange(hsv, np.array([0,   70, 50]), np.array([10,  255, 255]))
    m2 = cv2.inRange(hsv, np.array([170, 70, 50]), np.array([180, 255, 255]))
    return m1 | m2
 
def detect_blue(hsv):
    return cv2.inRange(hsv, np.array([100, 70, 50]), np.array([130, 255, 255]))
 
def detect_red_or_blue(hsv):
    return detect_red(hsv) | detect_blue(hsv)
 
def get_max_area(frm, y1, y2, x1, x2, mask_fn):
    roi  = frm[y1:y2, x1:x2]
    hsv  = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mask = mask_fn(hsv)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0, None
    lc = max(contours, key=cv2.contourArea)
    return cv2.contourArea(lc), cv2.boundingRect(lc)

# ==========================================
# 독립 카메라 읽기 스레드
# ==========================================
_latest_frames = {5: None, 6: None}
_frame_lock    = threading.Lock()

def _camera_reader_thread(cam_index, stop_flag: threading.Event):
    print(f"[CamThread] 카메라 {cam_index} 읽기 스레드 시작")
    frame_count       = 0
    loaded_strike     = 0
    WARMUP_FRAMES     = 60
    REQUIRED_STRIKES  = 60
    is_loaded_printed = False

    OBJ_MIN_AREA = 500

    while not stop_flag.is_set():
        cap = _get_or_open_cap(cam_index)
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.05)
            continue

        if cam_index == 5:
            frame_count += 1
            debug_frame = frame.copy()

            r_roi_y1, r_roi_y2 = 50,  240
            r_roi_x1, r_roi_x2 = 440, 640
            lr_roi_y1, lr_roi_y2 = 200, 300  # 왼쪽 빨강
            lr_roi_x1, lr_roi_x2 = 30,  200
            lb_roi_y1, lb_roi_y2 = 90, 190  # 왼쪽 파랑
            lb_roi_x1, lb_roi_x2 = 30,  200

            cv2.rectangle(debug_frame,
                          (r_roi_x1,  r_roi_y1),  (r_roi_x2,  r_roi_y2),  (255, 165, 0), 2)
            cv2.rectangle(debug_frame,
                          (lr_roi_x1, lr_roi_y1), (lr_roi_x2, lr_roi_y2), (0,   0,   255), 2)
            cv2.rectangle(debug_frame,
                          (lb_roi_x1, lb_roi_y1), (lb_roi_x2, lb_roi_y2), (255, 0,   0),   2)
 
            cv2.putText(debug_frame, "LOAD ROI",
                        (r_roi_x1  + 4, r_roi_y1  + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 165, 0), 1)
            cv2.putText(debug_frame, "RED ROI",
                        (lr_roi_x1 + 4, lr_roi_y1 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
            cv2.putText(debug_frame, "BLUE ROI",
                        (lb_roi_x1 + 4, lb_roi_y1 + 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 0, 0), 1)

            if frame_count < WARMUP_FRAMES:
                if frame_count % 20 == 0:
                    print(f"[Vision] 워밍업 중... ({frame_count}/{WARMUP_FRAMES})")
                cv2.putText(debug_frame, "Warming Up...", (20, 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)
            else:
                # ── 오른쪽 LOAD ROI (빨강+파랑) ──────────────────────
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
                    cv2.putText(debug_frame, "LOADED! (LOCKED)", (r_roi_x1, 40),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                elif loaded_strike >= REQUIRED_STRIKES and not is_loaded_printed:
                    cv2.putText(debug_frame, "LOADED!", (r_roi_x1, 40),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                    is_loaded_printed = True
 
                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_loaded(loaded_strike >= REQUIRED_STRIKES)
                    except Exception:
                        pass
 
                # ── 왼쪽 빨강 ROI ────────────────────────────────────
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
 
                # ── 왼쪽 파랑 ROI ────────────────────────────────────
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
 
            if global_queue_front is not None:
                try:
                    global_queue_front.put_nowait(debug_frame)
                except queue.Full:
                    pass
 
            with _frame_lock:
                _latest_frames[5] = frame.copy()
 
        elif cam_index == 6:
            if global_queue_wrist is not None:
                try:
                    global_queue_wrist.put_nowait(frame)
                except queue.Full:
                    pass
            with _frame_lock:
                _latest_frames[6] = frame.copy()
 
    print(f"[CamThread] 카메라 {cam_index} 읽기 스레드 종료")


# ==========================================
# HookedVideoCapture
# ==========================================
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
        if self.cam_index in MANAGED_INDICES:
            print(f"[Camera] release() 무시 → 카메라 {self.cam_index} 계속 유지")
            return
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


# ==========================================
# 메인 실행부
# ==========================================
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
    _get_or_open_cap(5)
    _get_or_open_cap(6)

    cam_stop_flag = threading.Event()
    threading.Thread(target=_camera_reader_thread, args=(5, cam_stop_flag), daemon=True).start()
    threading.Thread(target=_camera_reader_thread, args=(6, cam_stop_flag), daemon=True).start()
    print("[Camera] 카메라 읽기 스레드 시작 ✅\n")

    sys.argv = [
        "robot_client",
        "--robot.type=omx_follower",
        "--robot.port=/dev/omx_follower",
        '--robot.cameras={"front": {"type": "opencv", "index_or_path": 5,'
        ' "width": 640, "height": 480, "fps": 30},'
        ' "wrist": {"type": "opencv", "index_or_path": 6,'
        ' "width": 640, "height": 480, "fps": 30}}',
        "--robot.id=omx_follower_arm",
        "--task=Pick up Doll",
        "--pretrained_name_or_path=ttingji/omx617_total",
        "--policy_type=act",
        "--policy_device=cuda",
        "--client_device=cpu",
        "--server_address=10.10.14.63:5432",
        "--fps=24",
        "--actions_per_chunk=100",
        "--chunk_size_threshold=0.4",
        "--aggregate_fn_name=weighted_average",
    ]

    print("🚀 Flask 서버 및 ROS 2 노드 시작")
    print("PC 브라우저 접속: http://10.10.14.24:5000")
    print("발행 토픽:")
    print("  /vision/is_loaded       (Bool)")
    print("  /vision/object_detected (Bool)\n")

    while True:
        print("⏳ [대기] 추론 시작 신호를 기다립니다...")
        print("   → ros2 topic pub --once /vision/start_inference std_msgs/msg/Bool 'data: true'\n")
        start_event.wait()
        start_event.clear()
        stop_event.clear()

        global_ros_node.reset_loaded()

        watchdog = threading.Thread(target=stop_watchdog, args=(stop_event,), daemon=True)
        watchdog.start()

        print("🚀 [시작] 추론 루프를 시작합니다.")
        try:
            runpy.run_module("lerobot.async_inference.robot_client", run_name="__main__")
        except KeyboardInterrupt:
            print("\n🛑 추론 종료됨. 다시 신호를 기다립니다.")
        except Exception as e:
            print(f"오류: {e}")

        global_ros_node.enable_obj_detection()