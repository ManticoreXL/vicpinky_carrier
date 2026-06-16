import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
import cv2
import numpy as np
import threading
import time
import json
import sys
import imageio
import pygame
from pathlib import Path

DATASET_DIR   = Path("./omx616")   
FPS           = 30                             
IMG_W, IMG_H  = 640, 480                       

# 로컬 카메라 포트 설정
CAM_PORT_WRIST = 0  # 손목 웹캠
CAM_PORT_FRONT = 7  # 프론트 뎁스 카메라(RGB 스트림)

def rprint(msg: str):
    sys.stdout.write("\r" + msg + "\r\n")
    sys.stdout.flush()

class OMXDepthDataCollector(Node):
    def __init__(self):
        super().__init__("omx_depth_data_collector")

        self._recording    = False
        self._episode_data = []       
        self._all_episodes = []       
        self._episode_idx  = 0

        self._latest_leader   = None  
        self._latest_follower = None  
        self._latest_front    = None  
        self._latest_wrist    = None  
        self._frame_lock      = threading.Lock()

        # 데이터 저장 폴더 생성
        DATASET_DIR.mkdir(parents=True, exist_ok=True)
        (DATASET_DIR / "videos" / "observation.images.front").mkdir(parents=True, exist_ok=True)
        (DATASET_DIR / "videos" / "observation.images.wrist").mkdir(parents=True, exist_ok=True)
        (DATASET_DIR / "data").mkdir(parents=True, exist_ok=True)

        # 로봇 상태 토픽 구독 (드라이버 노드가 미리 실행되어 있어야 함)
        self.create_subscription(JointState, "/omx/leader_state", self._leader_cb, 10)
        self.create_subscription(JointState, "/omx/follower_state", self._follower_cb, 10)

        # 로컬 카메라 읽기 스레드
        self._cam_running = True
        self._cam_thread  = threading.Thread(target=self._cam_loop, daemon=True, name="cam")
        self._cam_thread.start()
        
        # 녹화 스레드
        self._rec_thread = threading.Thread(target=self._record_loop, daemon=True, name="recorder")
        self._rec_thread.start()

        rprint("=" * 60)
        rprint("🚀 OMX 로컬 데이터 수집기 가동 (Front: cam2, Wrist: cam0)")
        rprint("  [s]: 녹화 시작  [e]: 녹화 종료 및 저장")
        rprint("  [d]: 녹화 취소  [q]: 안전 종료")
        rprint("=" * 60)

    def _leader_cb(self, msg: JointState):
        with self._frame_lock: self._latest_leader = list(msg.position[:6])

    def _follower_cb(self, msg: JointState):
        with self._frame_lock: self._latest_follower = list(msg.position[:6])

    # ── 로컬 카메라 데이터 읽기 루프 ──
    def _cam_loop(self):
        # OpenCV로 로컬 웹캠 직접 열기
        cap_wrist = cv2.VideoCapture(CAM_PORT_WRIST)
        cap_front = cv2.VideoCapture(CAM_PORT_FRONT)

        # 카메라 해상도 및 FPS 설정
        for cap in (cap_wrist, cap_front):
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, IMG_W)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, IMG_H)
            cap.set(cv2.CAP_PROP_FPS, FPS)

        if not cap_wrist.isOpened() or not cap_front.isOpened():
            rprint("❌ 로컬 카메라를 여는 데 실패했습니다. 포트 번호(0, 2)를 확인해주세요.")

        rprint("[카메라] 로컬 카메라 2대(0번, 2번) 결합 성공")

        while self._cam_running:
            ret_w, frame_w = cap_wrist.read()
            ret_f, frame_f = cap_front.read()
            
            if ret_w and ret_f:
                with self._frame_lock:
                    self._latest_wrist = cv2.resize(frame_w, (IMG_W, IMG_H))
                    self._latest_front = cv2.resize(frame_f, (IMG_W, IMG_H))
            else:
                # 프레임을 읽지 못했을 때 CPU 점유율이 치솟는 것 방지
                time.sleep(0.01)

        cap_wrist.release()
        cap_front.release()

    def _record_loop(self):
        interval = 1.0 / FPS
        while True:
            t0 = time.time()
            if self._recording:
                with self._frame_lock:
                    leader, follower = self._latest_leader, self._latest_follower
                    front, wrist = self._latest_front, self._latest_wrist

                # 모든 데이터가 수신되고 있을 때만 기록
                if leader and follower and front is not None and wrist is not None:
                    self._episode_data.append({
                        "observation.state": follower,   
                        "action": leader,     
                        "observation.images.front": front.copy(),      
                        "observation.images.wrist": wrist.copy(),      
                        "timestamp": time.time(),
                    })
                    sys.stdout.write(f"\r[녹화 중] {len(self._episode_data)} 프레임 확보됨...")
                    sys.stdout.flush()

            elapsed = time.time() - t0
            sleep = interval - elapsed
            if sleep > 0: time.sleep(sleep)

    # ── Pygame UI 및 키보드 이벤트 루프 (메인 스레드에서 실행) ──
    def ui_loop(self):
        pygame.init()
        screen = pygame.display.set_mode((IMG_W * 2, IMG_H))
        pygame.display.set_caption("OMX Data Collector & Viewer (Local)")
        clock = pygame.time.Clock()
        
        font = pygame.font.SysFont(None, 36)
        small_font = pygame.font.SysFont(None, 24)

        while self._cam_running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self._finish()
                    return
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_s: self._start_episode()
                    elif event.key == pygame.K_e: self._end_episode()
                    elif event.key == pygame.K_d: self._discard_episode()
                    elif event.key == pygame.K_q: 
                        self._finish()
                        return

            with self._frame_lock:
                front = self._latest_front
                wrist = self._latest_wrist

            if front is not None and wrist is not None:
                # BGR -> RGB 변환 및 Pygame Surface 변환
                rgb_f = cv2.cvtColor(front, cv2.COLOR_BGR2RGB)
                rgb_w = cv2.cvtColor(wrist, cv2.COLOR_BGR2RGB)

                surf_f = pygame.surfarray.make_surface(np.transpose(rgb_f, (1, 0, 2)))
                surf_w = pygame.surfarray.make_surface(np.transpose(rgb_w, (1, 0, 2)))

                screen.blit(surf_f, (0, 0))
                screen.blit(surf_w, (IMG_W, 0))

                controls_txt = small_font.render("[S] Start  [E] End & Save  [D] Discard  [Q] Quit", True, (255, 255, 255))
                screen.blit(controls_txt, (10, IMG_H - 30))

                if self._recording:
                    pygame.draw.circle(screen, (255, 0, 0), (30, 30), 10)
                    rec_txt = font.render(f"REC - Ep: {self._episode_idx} | Frames: {len(self._episode_data)}", True, (255, 50, 50))
                    screen.blit(rec_txt, (50, 20))
                else:
                    ready_txt = font.render(f"READY - Ep: {self._episode_idx}", True, (0, 255, 0))
                    screen.blit(ready_txt, (20, 20))

                pygame.display.flip()

            clock.tick(FPS)
            
        pygame.quit()

    def _start_episode(self):
        if self._recording: return
        self._episode_data = []
        self._recording = True
        rprint(f"\n[●] 에피소드 {self._episode_idx} 녹화 시작!")

    def _end_episode(self):
        if not self._recording: return
        self._recording = False
        frames = self._episode_data
        self._episode_data = []

        if len(frames) < 5: return
        rprint(f"\n[■] 에피소드 {self._episode_idx} 완료. 파일 쓰기 시작...")
        
        threading.Thread(target=self._save_episode, args=(frames, self._episode_idx), daemon=True).start()
        self._all_episodes.append(self._episode_idx)
        self._episode_idx += 1

    def _discard_episode(self):
        if self._recording:
            self._recording = False
            self._episode_data = []
            return
        if not self._all_episodes: return
        last = self._all_episodes.pop()
        self._episode_idx -= 1
        for cam in ["observation.images.front", "observation.images.wrist"]:
            p = DATASET_DIR / "videos" / cam / f"episode_{last:06d}.mp4"
            if p.exists(): p.unlink()
        p = DATASET_DIR / "data" / f"episode_{last:06d}.json"
        if p.exists(): p.unlink()
        rprint(f"\n[d] 에피소드 {last} 파기 완료.")

    def _save_episode(self, frames: list, ep_idx: int):
        ep_str = f"episode_{ep_idx:06d}"

        processed_front, processed_wrist = [], []

        for f in frames:
            processed_front.append(cv2.cvtColor(f["observation.images.front"], cv2.COLOR_BGR2RGB))
            processed_wrist.append(cv2.cvtColor(f["observation.images.wrist"], cv2.COLOR_BGR2RGB))

        front_path = str(DATASET_DIR / "videos" / "observation.images.front" / f"{ep_str}.mp4")
        wrist_path = str(DATASET_DIR / "videos" / "observation.images.wrist" / f"{ep_str}.mp4")

        imageio.mimsave(front_path, processed_front, fps=FPS, format='FFMPEG', codec='libx264', pixelformat='yuv420p')
        imageio.mimsave(wrist_path, processed_wrist, fps=FPS, format='FFMPEG', codec='libx264', pixelformat='yuv420p')

        data = {
            "episode_index": ep_idx, "fps": FPS,
            "frames": [{
                "timestamp": f["timestamp"] - frames[0]["timestamp"],
                "observation.state": f["observation.state"],
                "action": f["action"], "frame_index": i,
            } for i, f in enumerate(frames)]
        }
        with open(DATASET_DIR / "data" / f"{ep_str}.json", "w") as fp: json.dump(data, fp)
        rprint(f"\r[✓] 에피소드 {ep_idx} 파일화 완료")

    def _finish(self):
        rprint(f"\n총 {len(self._all_episodes)}개 저장 완료.")
        rclpy.shutdown()

def main():
    rclpy.init()
    node = OMXDepthDataCollector()
    
    executor = rclpy.executors.SingleThreadedExecutor()
    executor.add_node(node)
    spin_thread = threading.Thread(target=executor.spin, daemon=True)
    spin_thread.start()

    try:
        node.ui_loop()
    except KeyboardInterrupt:
        pass
    finally:
        node._cam_running = False
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()

if __name__ == "__main__":
    main()