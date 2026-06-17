#!/usr/bin/env python3
# =====================================================================
# robot_camera_mjpeg.py  (로봇 측 캡처 전용 MJPEG 송신기 — 모델 없음)
#
# 로봇에서 실행 -> PC 에서:  python3 people_viewer.py --source http://<robot_ip>:5000
#
# 주의:
#   - 카메라 장치는 ls /dev/video* 로 확인. --device 0 또는 1 로 맞추기.
#   - WebRTC 송출기와 '같은 카메라'를 동시에 못 엶(V4L2 보통 단독 점유).
#     프로토타입 테스트 땐 둘 중 하나만 띄우거나, 카메라가 2개면 다른 index 사용.
# =====================================================================
import argparse
import threading
import time

import cv2
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

_lock = threading.Lock()
_latest_jpeg = None


class CaptureThread(threading.Thread):
    """카메라를 한 스레드에서만 읽어 최신 JPEG 1장 유지(클라이언트 수 무관)."""
    def __init__(self, device, width, height, fps, quality):
        super().__init__(daemon=True)
        self.quality = quality
        self.interval = 1.0 / max(1, fps)
        self.running = True
        self.cap = cv2.VideoCapture(device)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        if not self.cap.isOpened():
            raise RuntimeError(f"카메라 장치 {device} 열기 실패 (ls /dev/video* 확인)")

    def run(self):
        global _latest_jpeg
        while self.running:
            t0 = time.time()
            ok, frame = self.cap.read()
            if ok and frame is not None:
                ok2, buf = cv2.imencode('.jpg', frame,
                                        [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
                if ok2:
                    with _lock:
                        _latest_jpeg = buf.tobytes()
            dt = self.interval - (time.time() - t0)
            if dt > 0:
                time.sleep(dt)

    def stop(self):
        self.running = False
        self.cap.release()


class MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/', '/stream'):
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.end_headers()
        try:
            while True:
                with _lock:
                    jpg = _latest_jpeg
                if jpg is None:
                    time.sleep(0.03); continue
                self.wfile.write(b'--frame\r\n')
                self.wfile.write(b'Content-Type: image/jpeg\r\n')
                self.wfile.write(f'Content-Length: {len(jpg)}\r\n\r\n'.encode())
                self.wfile.write(jpg)
                self.wfile.write(b'\r\n')
                time.sleep(0.03)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 클라이언트가 끊은 것 — 정상

    def log_message(self, *args):
        pass  # 접속 로그 끄기


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="로봇 캡처 전용 MJPEG 송신기")
    ap.add_argument('--device', type=int, default=0, help="카메라 index (ls /dev/video*)")
    ap.add_argument('--port', type=int, default=5000)
    ap.add_argument('--width', type=int, default=640)
    ap.add_argument('--height', type=int, default=480)
    ap.add_argument('--fps', type=int, default=15)
    ap.add_argument('--quality', type=int, default=70, help="JPEG 품질 1~100(낮을수록 대역폭↓)")
    args = ap.parse_args()

    cam = CaptureThread(args.device, args.width, args.height, args.fps, args.quality)
    cam.start()
    srv = ThreadedHTTPServer(('0.0.0.0', args.port), MJPEGHandler)
    print(f"[mjpeg] /dev/video{args.device} -> http://0.0.0.0:{args.port}  (Ctrl+C 종료)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cam.stop()
        srv.shutdown()


if __name__ == "__main__":
    main()
