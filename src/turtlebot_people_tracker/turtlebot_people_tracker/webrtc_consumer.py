#!/usr/bin/env python3
# =====================================================================
# webrtc_consumer.py  (PC) — 로봇 WebRTC 스트림을 받아 사람검출 코어에 공급
#
# 시그널링(서버 devtools로 확인된 값):
#   - 요청:  emit "webrtc_request_stream" {"botId": "<cam id>"}
#   - botId 는 "vicpinky_cam0" / "vicpinky_cam1" (카메라 2채널)
#   - 서버가 이벤트명을 robot<->browser 사이에서 바꾸므로, offer/answer 의
#     '브라우저쪽' 이름은 미지수 -> 받는 이벤트는 전부 로그 + SDP 들어오면 offer 자동인식.
#
# 같은 폴더에 people_viewer.py, best.onnx 필요.
# 설치:  pip install aiortc av "python-socketio[client]" opencv-python onnxruntime numpy
# 실행:  python3 webrtc_consumer.py --bot-id vicpinky_cam0
# =====================================================================
import argparse
import asyncio
import threading
import time

import cv2
import numpy as np
import socketio
from aiortc import RTCPeerConnection, RTCSessionDescription

from people_viewer import PersonDetector, draw_detections, detections_to_payload

# ── 시그널링 이벤트 ───────────────────────────────────────────────────────────
REQUEST_EVENT = "webrtc_request_stream"   # 브라우저가 스트림 요청 (devtools 확인됨)
ANSWER_EVENT  = "webrtc_answer"           # 내가 보내는 answer (추정 — 안 되면 로그 보고 교체)
ICE_EVENT     = "webrtc_ice_candidate"    # (보통 SDP에 ICE 포함되어 불필요)

# ── 공유 프레임 (asyncio 수신 -> 메인 스레드 표시) ────────────────────────────
_lock = threading.Lock()
_frame = None


class Consumer:
    def __init__(self, server, bot_id, loop):
        self.server = server
        self.bot_id = bot_id
        self.loop = loop
        self.pc = None
        self.sio = socketio.Client(reconnection=True, reconnection_attempts=0,
                                   reconnection_delay=3, logger=False, engineio_logger=False)
        self._setup()

    def _setup(self):
        sio = self.sio

        @sio.event
        def connect():
            print(f"[ok] 서버 연결됨 -> 스트림 요청  botId={self.bot_id}")
            sio.emit(REQUEST_EVENT, {"botId": self.bot_id})   # 대시보드와 동일 payload

        @sio.event
        def disconnect():
            print("[..] 서버 연결 끊김")

        # 받는 모든 이벤트 로그 + offer/ice 자동 라우팅 (서버가 이름 바꿔도 동작)
        @sio.on('*')
        def catch_all(event, data):
            snippet = str(data)
            print(f"[recv] {event}: {snippet[:160]}")
            if isinstance(data, dict) and data.get('sdp') and \
               (data.get('type') == 'offer' or 'offer' in str(event).lower()):
                asyncio.run_coroutine_threadsafe(self._on_offer(data), self.loop)
            elif isinstance(data, dict) and (data.get('candidate') or 'ice' in str(event).lower()):
                asyncio.run_coroutine_threadsafe(self._on_ice(data), self.loop)

    async def _on_offer(self, data):
        print("[ok] offer 인식 -> answer 생성")
        browser_id = data.get("browserId")     # 있으면 그대로 echo, 없으면 생략
        sdp, sdp_type = data.get("sdp"), data.get("type", "offer")

        if self.pc is not None:
            try: await self.pc.close()
            except Exception: pass
        pc = RTCPeerConnection()
        self.pc = pc

        @pc.on("track")
        def on_track(track):
            print(f"[ok] 트랙 수신: {track.kind}")
            if track.kind == "video":
                asyncio.ensure_future(self._consume(track))

        @pc.on("connectionstatechange")
        async def on_state():
            print(f"[..] 연결 상태: {pc.connectionState}")

        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)   # aiortc가 ICE를 SDP에 담아줌

        payload = {"botId": self.bot_id,
                   "sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        if browser_id is not None:
            payload["browserId"] = browser_id
        self.sio.emit(ANSWER_EVENT, payload)
        print(f"[ok] answer 전송 ('{ANSWER_EVENT}')")

    async def _on_ice(self, data):
        return  # 대개 불필요

    def start(self):
        def run():
            try:
                self.sio.connect(self.server, transports=["polling", "websocket"], wait_timeout=10)
                while True:
                    time.sleep(1)
            except Exception as e:
                print("[!!] 시그널링 오류:", e)
        threading.Thread(target=run, daemon=True).start()

    async def _consume(self, track):
        global _frame
        while True:
            try:
                vf = await track.recv()
            except Exception:
                print("[..] 트랙 종료"); break
            with _lock:
                _frame = vf.to_ndarray(format="bgr24")


def main():
    ap = argparse.ArgumentParser(description="PC WebRTC 소비자 + 사람검출")
    ap.add_argument("--server", default="http://10.10.14.70:3001")
    ap.add_argument("--bot-id", default="vicpinky_cam0", help="vicpinky_cam0 또는 vicpinky_cam1")
    ap.add_argument("--model", default="best.onnx")
    ap.add_argument("--conf", type=float, default=0.35)
    args = ap.parse_args()

    detector = PersonDetector(args.model, conf_th=args.conf)

    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()

    consumer = Consumer(args.server, args.bot_id, loop)
    consumer.start()
    print("[..] 대기 중...  (창에서 q 종료)")
    print("     서버가 보내는 이벤트가 [recv] 로 다 찍힘. offer(sdp 포함)가 와야 영상 시작.")

    prev, fps = time.time(), 0.0
    while True:
        with _lock:
            img = None if _frame is None else _frame.copy()
        if img is not None:
            dets = detector.detect(img)
            now = time.time(); fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev, 1e-6)); prev = now
            draw_detections(img, dets)
            cv2.putText(img, f"{fps:4.1f} fps | {len(dets)} person", (8, 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            cv2.imshow("webrtc_consumer", img)
        else:
            time.sleep(0.01)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
