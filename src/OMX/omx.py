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
from std_msgs.msg import Bool, Float64MultiArray
from sensor_msgs.msg import JointState

# ==========================================
# 0. ROS 2 통신 노드
# ==========================================
class OmxStateNode(Node):
    def __init__(self, start_event, stop_event):
        super().__init__('omx_state_node')
        self.start_event = start_event
        self.stop_event  = stop_event

        self.loaded_pub    = self.create_publisher(Bool,             '/vision/is_loaded',    10)
        self.motor_pos_pub = self.create_publisher(Float64MultiArray, '/vision/motor_position', 10)
        self.motor_vel_pub = self.create_publisher(Float64MultiArray, '/vision/motor_velocity', 10)
        self.motor_eff_pub = self.create_publisher(Float64MultiArray, '/vision/motor_effort',   10)

        self.start_sub = self.create_subscription(
            Bool, '/vision/start_inference', self.start_callback, 10)

        self.loaded_start_time    = None
        self.last_published_state = None
        self._last_motor_print    = 0.0
        print("🚀 [노드 시작] 추론 제어 대기 중...")

    def start_callback(self, msg):
        if msg.data:
            print("🔥 추론 시작 신호 수신!")
            self.start_event.set()

    # ✅ LeRobot 후킹으로 받은 모터값을 여기서 발행
    def publish_motor(self, positions, velocities, efforts):
        now = time.time()
        if positions:
            self.motor_pos_pub.publish(Float64MultiArray(data=list(positions)))
        if velocities:
            self.motor_vel_pub.publish(Float64MultiArray(data=list(velocities)))
        if efforts:
            self.motor_eff_pub.publish(Float64MultiArray(data=list(efforts)))

        if now - self._last_motor_print >= 1.0:
            pos_str = ", ".join(f"{p:.3f}" for p in positions) if positions else "-"
            vel_str = ", ".join(f"{v:.3f}" for v in velocities) if velocities else "-"
            print(f"[모터] pos=[{pos_str}]  vel=[{vel_str}]")
            self._last_motor_print = now

    def publish_loaded(self, is_loaded):
        val = bool(is_loaded)
        if self.last_published_state != val:
            self.loaded_pub.publish(Bool(data=val))
            self.last_published_state = val
        self.check_and_stop(val)

    def check_and_stop(self, is_loaded):
        if is_loaded:
            if self.loaded_start_time is None:
                self.loaded_start_time = time.time()
            elif time.time() - self.loaded_start_time >= 5.0:
                if not self.stop_event.is_set():
                    print("⚠️ LOADED 완료! 추론을 정지합니다.")
                    self.stop_event.set()
        else:
            self.loaded_start_time = None


# ==========================================
# 1. LeRobot 모터 후킹
# ==========================================
def _hook_lerobot_motor(ros_node):
    """
    LeRobot 의 dynamixel 버스 read 함수를 후킹해서
    모터 position/velocity/effort 를 ROS 2 로 발행.

    lerobot 패키지 구조에 따라 후킹 대상이 다를 수 있음:
      - lerobot.common.robot_devices.motors.dynamixel  →  DynamixelMotorsBus.read()
      - lerobot.common.robot_devices.robots.manipulator → ManipulatorRobot._read_state()
    아래는 DynamixelMotorsBus.read() 후킹 방식.
    """
    try:
        from lerobot.common.robot_devices.motors import dynamixel as _dyn_mod
        OrigBus = _dyn_mod.DynamixelMotorsBus
        _orig_read = OrigBus.read

        def _hooked_read(self_bus, data_name, *args, **kwargs):
            result = _orig_read(self_bus, data_name, *args, **kwargs)
            if ros_node is None or not rclpy.ok():
                return result
            try:
                positions  = []
                velocities = []
                efforts    = []
                if data_name == "Present_Position":
                    positions = list(result.values()) if isinstance(result, dict) else list(result)
                elif data_name == "Present_Velocity":
                    velocities = list(result.values()) if isinstance(result, dict) else list(result)
                elif data_name == "Present_Current":
                    efforts = list(result.values()) if isinstance(result, dict) else list(result)

                if positions or velocities or efforts:
                    ros_node.publish_motor(positions, velocities, efforts)
            except Exception:
                pass
            return result

        OrigBus.read = _hooked_read
        print("[Hook] DynamixelMotorsBus.read() 후킹 완료 ✅")

    except ImportError:
        print("[Hook] ⚠️ DynamixelMotorsBus 임포트 실패 — 모터 후킹 건너뜀")
    except Exception as e:
        print(f"[Hook] ⚠️ 모터 후킹 오류: {e}")


# ==========================================
# 2. Flask 웹 서버 프로세스
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
                ret, buffer = cv2.imencode('.jpg', frame, encode_param)
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
# 3. 영구 카메라 관리
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
# 4. 독립 카메라 읽기 스레드 (추론과 무관하게 항상 동작)
# ==========================================
# 최신 프레임을 스레드 안전하게 보관
_latest_frames = {5: None, 6: None}
_frame_lock    = threading.Lock()

def _camera_reader_thread(cam_index, stop_flag: threading.Event):
    """
    ✅ 핵심 수정: 추론 루프와 완전히 분리된 독립 스레드에서 카메라를 읽음.
    LeRobot 이 종료되어도 이 스레드는 계속 동작 → Flask 화면 유지.
    """
    print(f"[CamThread] 카메라 {cam_index} 읽기 스레드 시작")
    frame_count      = 0
    loaded_strike    = 0
    WARMUP_FRAMES    = 60
    REQUIRED_STRIKES = 60
    is_loaded_printed = False

    while not stop_flag.is_set():
        cap = _get_or_open_cap(cam_index)
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.05)
            continue

        if cam_index == 5:
            frame_count += 1
            debug_frame = frame.copy()

            roi_y1, roi_y2, roi_x1, roi_x2 = 50, 240, 440, 640
            cv2.rectangle(debug_frame, (roi_x1, roi_y1), (roi_x2, roi_y2), (255, 0, 0), 2)

            if frame_count < WARMUP_FRAMES:
                if frame_count % 20 == 0:
                    print(f"[Vision] 워밍업 중... ({frame_count}/{WARMUP_FRAMES})")
                cv2.putText(debug_frame, "Warming Up...", (20, 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)
            else:
                roi     = frame[roi_y1:roi_y2, roi_x1:roi_x2]
                hsv_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
                mask    = cv2.inRange(hsv_roi,
                                      np.array([0, 50, 50]),
                                      np.array([180, 255, 255]))
                contours, _ = cv2.findContours(
                    mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

                max_area = 0
                if contours:
                    lc = max(contours, key=cv2.contourArea)
                    max_area = cv2.contourArea(lc)
                    x, y, w, h = cv2.boundingRect(lc)
                    cv2.rectangle(debug_frame,
                                  (x+roi_x1, y+roi_y1),
                                  (x+w+roi_x1, y+h+roi_y1),
                                  (0, 255, 255), 2)

                if max_area > 1500:
                    loaded_strike += 1
                    cv2.putText(debug_frame,
                                f"Detecting: {max_area:.0f}px "
                                f"(S:{loaded_strike}/{REQUIRED_STRIKES})",
                                (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
                else:
                    loaded_strike     = 0
                    is_loaded_printed = False

                loaded_status = loaded_strike >= REQUIRED_STRIKES

                if loaded_status:
                    cv2.putText(debug_frame, "LOADED!", (20, 40),
                                cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
                    if not is_loaded_printed:
                        print("\n=======================================================")
                        print("🎯 LOADED! 터틀봇 위에 물건이 완벽하게 안착되었습니다!")
                        print("=======================================================\n")
                        is_loaded_printed = True

                if global_ros_node is not None and rclpy.ok():
                    try:
                        global_ros_node.publish_loaded(loaded_status)
                    except Exception:
                        pass

            # Flask 큐에 전달
            if global_queue_front is not None:
                try:
                    global_queue_front.put_nowait(debug_frame)
                except queue.Full:
                    pass

            # 최신 프레임 저장 (LeRobot 이 read() 할 때 반환용)
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
# 5. HookedVideoCapture — 독립 스레드의 최신 프레임을 반환
# ==========================================
class HookedVideoCapture:
    """
    LeRobot 이 read() 를 호출하면 독립 스레드가 미리 읽어둔 최신 프레임을 반환.
    release() 는 무시 → 장치 유지.
    """

    def __init__(self, *args, **kwargs):
        try:
            self.cam_index = int(args[0]) if args else None
        except (ValueError, TypeError):
            self.cam_index = None

        if self.cam_index not in MANAGED_INDICES:
            self._cap = OriginalVideoCapture(*args, **kwargs)
        else:
            self._cap = None  # 독립 스레드가 관리

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
            return True  # 독립 스레드가 항상 읽고 있음
        return self._cap.grab() if self._cap else False

    def retrieve(self, *args, **kwargs):
        if self.cam_index in MANAGED_INDICES:
            with _frame_lock:
                f = _latest_frames.get(self.cam_index)
            if f is not None:
                return True, f.copy()
            return False, None
        return self._cap.retrieve(*args, **kwargs) if self._cap else (False, None)

    def read(self, *args, **kwargs):
        if self.cam_index in MANAGED_INDICES:
            # 독립 스레드가 읽어둔 최신 프레임 반환
            with _frame_lock:
                f = _latest_frames.get(self.cam_index)
            if f is not None:
                return True, f.copy()
            # 아직 프레임이 없으면 직접 읽기 (초기 워밍업)
            cap = _get_or_open_cap(self.cam_index)
            return cap.read(*args, **kwargs)
        return self._cap.read(*args, **kwargs) if self._cap else (False, None)


cv2.VideoCapture = HookedVideoCapture


# ==========================================
# stop_event 감시 watchdog
# ==========================================
def stop_watchdog(stop_event):
    stop_event.wait()
    print("\n[Watchdog] stop_event 감지 → 추론 루프 종료")
    _thread.interrupt_main()


# ==========================================
# 6. 메인 실행부
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

    # ✅ 카메라 사전 오픈
    print("[Camera] 카메라 사전 오픈 중...")
    _get_or_open_cap(5)
    _get_or_open_cap(6)

    # ✅ 독립 카메라 읽기 스레드 시작 (프로그램 종료 전까지 계속 동작)
    cam_stop_flag = threading.Event()
    threading.Thread(target=_camera_reader_thread, args=(5, cam_stop_flag), daemon=True).start()
    threading.Thread(target=_camera_reader_thread, args=(6, cam_stop_flag), daemon=True).start()
    print("[Camera] 카메라 읽기 스레드 시작 ✅\n")

    # ✅ LeRobot 모터 후킹
    _hook_lerobot_motor(global_ros_node)

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
    print("  /vision/is_loaded        (Bool)")
    print("  /vision/motor_position   (Float64MultiArray)")
    print("  /vision/motor_velocity   (Float64MultiArray)")
    print("  /vision/motor_effort     (Float64MultiArray)\n")

    while True:
        print("⏳ [대기] 추론 시작 신호를 기다립니다...")
        print("   → ros2 topic pub --once /vision/start_inference std_msgs/msg/Bool 'data: true'\n")
        start_event.wait()
        start_event.clear()
        stop_event.clear()

        watchdog = threading.Thread(target=stop_watchdog, args=(stop_event,), daemon=True)
        watchdog.start()

        print("🚀 [시작] 추론 루프를 시작합니다.")
        try:
            runpy.run_module("lerobot.async_inference.robot_client", run_name="__main__")
        except KeyboardInterrupt:
            print("\n🛑 추론 종료됨. 다시 신호를 기다립니다.")
        except Exception as e:
            print(f"오류: {e}")