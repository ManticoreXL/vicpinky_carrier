import asyncio
import threading
import logging
import time
import argparse
from fractions import Fraction

import cv2
import numpy as np
import socketio
from av import VideoFrame
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("robot_webrtc")


# ── 공유 프레임 버퍼 ──────────────────────────────────────────────────────────

class SharedFrameBuffer:
    """
    카메라 최신 프레임 1개만 유지. 참조만 공유 (복사 없음).
    모든 클라이언트가 동일한 최신 프레임을 읽어 드리프트 없음.
    """
    def __init__(self):
        self._frame: np.ndarray | None = None
        self._lock = threading.Lock()

    def write(self, frame: np.ndarray):
        with self._lock:
            # 이전 프레임은 자동으로 GC되고, 새 프레임 참조만 저장
            self._frame = frame

    def read(self) -> np.ndarray | None:
        with self._lock:
            # 참조만 반환 (복사 없음 = 메모리 절약)
            return self._frame


# ── 카메라 캡처 스레드 ────────────────────────────────────────────────────────

class CameraReader:
    """
    별도 스레드에서 카메라를 읽어 SharedFrameBuffer에 계속 업데이트.
    클라이언트 수와 무관하게 카메라는 항상 1개 스레드만 사용.
    """
    def __init__(self, device: int, width: int, height: int, fps: int):
        self.buffer = SharedFrameBuffer()
        self.width = width
        self.height = height
        self._fps = fps
        self._running = False
        self._thread: threading.Thread | None = None

        self.cap = cv2.VideoCapture(device)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)

        if not self.cap.isOpened():
            raise RuntimeError(f"카메라 장치 {device} 열기 실패")
        logger.info(f"카메라 {device} 열림 ({width}x{height} @ {fps}fps)")

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("카메라 캡처 스레드 시작")

    def _loop(self):
        interval = 1.0 / self._fps
        while self._running:
            t0 = time.time()
            ret, frame_bgr = self.cap.read()
            if ret:
                frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                self.buffer.write(frame_rgb)
            elapsed = time.time() - t0
            sleep = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    def stop(self):
        self._running = False
        self.cap.release()
        logger.info("카메라 캡처 스레드 종료")


# ── 클라이언트별 라이브 트랙 ──────────────────────────────────────────────────

class LiveCameraTrack(VideoStreamTrack):
    """
    공유 버퍼에서 최신 프레임만 읽어 전송.
    큐 없이 항상 현재 프레임 → 모든 클라이언트 동일한 화면.
    pts/time_base 는 aiortc 표준 next_timestamp() 로 처리 (안정적 페이싱).
    """
    kind = "video"

    def __init__(self, buffer: SharedFrameBuffer, width: int = 640, height: int = 480, fps: int = 15):
        super().__init__()
        self._buffer = buffer
        self._blank = np.zeros((height, width, 3), dtype=np.uint8)
        self._fps = max(1, fps)
        self._clock = 90000
        self._step = int(self._clock / self._fps)
        self._tb = Fraction(1, self._clock)
        self._start: float | None = None
        self._ts = 0

    async def recv(self) -> VideoFrame:
        # 설정 fps로 페이싱 (단조 증가 pts) → 부하↓ + 브라우저 지터버퍼 안정
        if self._start is None:
            self._start = time.time()
            self._ts = 0
        else:
            self._ts += self._step
            wait = self._start + self._ts / self._clock - time.time()
            if wait > 0:
                await asyncio.sleep(wait)

        frame = self._buffer.read()
        if frame is None:
            frame = self._blank

        vf = VideoFrame.from_ndarray(frame, format="rgb24")
        vf.pts = self._ts
        vf.time_base = self._tb
        return vf


# ── WebRTC 연결 관리 ──────────────────────────────────────────────────────────

class WebRTCManager:
    def __init__(self, bot_id: str, camera: CameraReader, max_kbps: int = 600):
        self.bot_id = bot_id
        self.camera = camera
        self.max_kbps = max_kbps      # 영상 대역폭 상한 (약한 WiFi 안정화)
        self.pcs: dict[str, RTCPeerConnection] = {}
        self._lock = asyncio.Lock()

    def _cap_bitrate(self, sdp: str) -> str:
        """SDP video 섹션에 대역폭 상한(b=AS/b=TIAS) 삽입 → 인코더 과송출 방지."""
        if not self.max_kbps:
            return sdp
        out = []
        for line in sdp.split("\r\n"):
            out.append(line)
            if line.startswith("m=video"):
                out.append(f"b=AS:{self.max_kbps}")
                out.append(f"b=TIAS:{self.max_kbps * 1000}")
        return "\r\n".join(out)

    async def create_offer(self, browser_id: str) -> dict:
        async with self._lock:
            # 같은 브라우저의 기존 연결이 있으면 완전히 정리 후 재생성
            old = self.pcs.pop(browser_id, None)
            if old is not None:
                try:
                    await old.close()
                except Exception:
                    pass

            # LAN 직결: STUN 없이 host candidate만 사용 → 빠르고 안정적
            # (인터넷 없는 로봇에서 STUN 타임아웃으로 연결 실패하는 문제 제거)
            pc = RTCPeerConnection()
            self.pcs[browser_id] = pc

            # 클라이언트마다 독립 트랙 — 공유 버퍼에서 최신 프레임 읽음
            track = LiveCameraTrack(
                self.camera.buffer,
                width=self.camera.width,
                height=self.camera.height,
                fps=self.camera._fps,
            )
            pc.addTrack(track)

            @pc.on("connectionstatechange")
            async def on_state():
                state = pc.connectionState
                logger.info(f"[{browser_id}] 연결 상태: {state}")
                if state in ("failed", "closed", "disconnected"):
                    async with self._lock:
                        # 현재 등록된 게 바로 이 pc일 때만 제거 (재연결 레이스 방지)
                        if self.pcs.get(browser_id) is pc:
                            self.pcs.pop(browser_id, None)
                    try:
                        await pc.close()
                    except Exception:
                        pass
                    logger.info(f"현재 송출 수: {len(self.pcs)}")

            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)

            logger.info(f"[{browser_id}] Offer 생성 | 송출 수: {len(self.pcs)} | 상한 {self.max_kbps}kbps")
            return {
                "sdp": self._cap_bitrate(pc.localDescription.sdp),
                "type": pc.localDescription.type,
            }

    async def handle_answer(self, browser_id: str, sdp: str, sdp_type: str):
        pc = self.pcs.get(browser_id)
        if not pc:
            return
        await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        logger.info(f"[{browser_id}] Answer 설정 완료")

    async def handle_ice(self, browser_id: str, candidate: dict):
        pc = self.pcs.get(browser_id)
        if not pc:
            return
        from aiortc import RTCIceCandidate
        ice = RTCIceCandidate(
            component=candidate.get("component", 1),
            foundation=candidate.get("foundation", ""),
            ip=candidate.get("ip", ""),
            port=candidate.get("port", 0),
            priority=candidate.get("priority", 0),
            protocol=candidate.get("protocol", "udp"),
            type=candidate.get("type", "host"),
            sdpMid=candidate.get("sdpMid"),
            sdpMLineIndex=candidate.get("sdpMLineIndex"),
        )
        await pc.addIceCandidate(ice)

    async def close_all(self):
        async with self._lock:
            for pc in self.pcs.values():
                await pc.close()
            self.pcs.clear()


# ── Socket.IO 시그널링 ────────────────────────────────────────────────────────

class SignalingClient:
    def __init__(self, server_url: str, bot_id: str, webrtc: WebRTCManager,
                 loop: asyncio.AbstractEventLoop):
        self.server_url = server_url
        self.bot_id = bot_id
        self.webrtc = webrtc
        self.loop = loop
        # reconnection=True: 자동 재연결, 이벤트 핸들러는 계속 유지
        self.sio = socketio.Client(reconnection=True, reconnection_attempts=0,
                                   reconnection_delay=3, logger=False, engineio_logger=False)
        self._setup_events()

    def _setup_events(self):
        sio = self.sio

        @sio.event
        def connect():
            logger.info(f"NestJS 연결됨: {self.server_url}")
            sio.emit("robot_register", {"botId": self.bot_id, "type": "camera"})

        @sio.event
        def disconnect():
            logger.warning("NestJS 연결 끊김")

        @sio.on("robot_registered")
        def on_registered(data):
            logger.info(f"로봇 등록 완료: {self.bot_id}")

        @sio.on("browser_wants_stream")
        def on_wants_stream(data):
            browser_id = data.get("browserId")
            target_bot = data.get("botId")
            # 검증: 이 요청이 정말 내 botId 대상인가?
            if target_bot is not None and target_bot != self.bot_id:
                logger.warning(
                    f"무시: 요청 대상 botId={target_bot} 이지만 내 botId={self.bot_id}"
                )
                return
            logger.info(f"[{browser_id}] 스트림 요청 (botId={self.bot_id})")
            asyncio.run_coroutine_threadsafe(
                self._send_offer(browser_id), self.loop
            )

        @sio.on("webrtc_answer")
        def on_answer(data):
            browser_id = data.get("browserId")
            sdp      = data.get("sdp")
            sdp_type = data.get("type", "answer")
            asyncio.run_coroutine_threadsafe(
                self.webrtc.handle_answer(browser_id, sdp, sdp_type), self.loop
            )

        @sio.on("webrtc_ice_candidate")
        def on_ice(data):
            browser_id = data.get("browserId")
            candidate  = data.get("candidate", {})
            asyncio.run_coroutine_threadsafe(
                self.webrtc.handle_ice(browser_id, candidate), self.loop
            )

    async def _send_offer(self, browser_id: str):
        offer = await self.webrtc.create_offer(browser_id)
        self.sio.emit("webrtc_offer", {
            "botId":     self.bot_id,
            "browserId": browser_id,
            "sdp":       offer["sdp"],
            "type":      offer["type"],
        })
        logger.info(f"[{browser_id}] Offer 전송 완료")

    def start(self):
        def run():
            try:
                # 인스턴스는 한 번만 생성 (재연결은 자동)
                self.sio.connect(
                    self.server_url,
                    transports=["polling", "websocket"],
                    wait_timeout=10,
                )
                # 연결 유지 (자동 재연결이 처리함)
                while True:
                    time.sleep(1)
            except Exception as e:
                logger.error(f"시그널링 오류: {e}")

        threading.Thread(target=run, daemon=True).start()
        logger.info("시그널링 스레드 시작")

    def stop(self):
        try:
            self.sio.disconnect()
        except Exception:
            pass


# ── 메인 ─────────────────────────────────────────────────────────────────────

async def main(args):
    loop = asyncio.get_event_loop()

    camera    = CameraReader(args.device, args.width, args.height, args.fps)
    camera.start()

    webrtc    = WebRTCManager(bot_id=args.bot_id, camera=camera, max_kbps=args.max_kbps)
    signaling = SignalingClient(
        server_url=args.server,
        bot_id=args.bot_id,
        webrtc=webrtc,
        loop=loop,
    )

    signaling.start()

    logger.info(f"봇 ID: {args.bot_id} | 카메라: /dev/video{args.device} | 서버: {args.server}")
    logger.info("Ctrl+C로 종료")

    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("종료 중...")
    finally:
        signaling.stop()
        await webrtc.close_all()
        camera.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="터틀봇 WebRTC 카메라 스트리머")
    parser.add_argument("--bot-id",  default="tb3_01",                  help="로봇 ID")
    parser.add_argument("--device",  type=int, default=0,               help="카메라 장치 번호")
    parser.add_argument("--server",  default="http://10.10.14.70:3001", help="NestJS 서버 URL")
    parser.add_argument("--width",    type=int, default=320, help="해상도 폭 (약한 WiFi면 낮게)")
    parser.add_argument("--height",   type=int, default=240, help="해상도 높이")
    parser.add_argument("--fps",      type=int, default=15,  help="프레임레이트")
    parser.add_argument("--max-kbps", type=int, default=600, help="영상 대역폭 상한(kbps). 0=무제한")
    args = parser.parse_args()

    asyncio.run(main(args))
