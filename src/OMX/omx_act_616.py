#!/usr/bin/env python3
"""
OMX + LeRobot v3.0 ROS 2 커스텀 추론 노드 — 버전 2: 락 범위 축소
- 문제: _state_lock 하나로 카메라 저장 + 추론 copy()를 동시에 막아 상호 블로킹 발생
- 해결:
    1. copy()를 락 밖으로 꺼내 락 점유 시간 최소화
    2. 카메라 프레임용 _cam_lock / 조인트 상태용 _state_lock 으로 락 분리
       → 카메라 루프와 상태 콜백이 서로 독립적으로 동작
- 나머지: GPU 추론 구조(앙상블 포함)는 원본 유지
"""

import sys
import math
import threading
import time
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Float32MultiArray
import cv2
import numpy as np
import torch
import json
from huggingface_hub import hf_hub_download

from lerobot.policies.act.modeling_act import ACTPolicy, ACTTemporalEnsembler

IMG_W, IMG_H   = 640, 480
CAM_PORT_WRIST = 0
CAM_PORT_FRONT = 7
FPS            = 30


class OMXInferenceNode(Node):
    def __init__(self):
        super().__init__("omx_inference_node")

        self.declare_parameter("model_path", "ttingji/omx616")
        self.declare_parameter("dataset_repo", "ttingji/cube")
        self.declare_parameter("cam_wrist",    CAM_PORT_WRIST)
        self.declare_parameter("cam_front",    CAM_PORT_FRONT)

        self.model_path   = self.get_parameter("model_path").get_parameter_value().string_value
        self.dataset_repo = self.get_parameter("dataset_repo").get_parameter_value().string_value
        self.cam_wrist    = self.get_parameter("cam_wrist").get_parameter_value().integer_value
        self.cam_front    = self.get_parameter("cam_front").get_parameter_value().integer_value

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        self._load_policy()
        self._load_stats()

        # ── 버전 2 핵심: 락을 역할별로 분리 ────────────────────────────────
        # 카메라 프레임 전용 락 (카메라 루프 ↔ 추론 루프)
        self._cam_lock   = threading.Lock()
        # 조인트 상태 전용 락 (ROS 콜백 ↔ 추론 루프)
        self._state_lock = threading.Lock()
        # ────────────────────────────────────────────────────────────────────

        self._latest_follower_state = None
        self._latest_front = None
        self._latest_wrist = None

        self.cmd_pub = self.create_publisher(Float32MultiArray, "/omx/joint_commands", 10)
        self.state_sub = self.create_subscription(
            JointState, "/omx/follower_state", self._state_cb, 10
        )

        self._cam_running = True
        self._cam_thread = threading.Thread(target=self._cam_loop, daemon=True)
        self._cam_thread.start()

        self._display_thread = threading.Thread(target=self._display_loop, daemon=True)
        self._display_thread.start()

        self.timer = self.create_timer(1.0 / FPS, self._inference_loop)
        self.get_logger().info("🚀 [V2] 락 분리 방식 추론 시작!")
        self.get_logger().info(f"  카메라: wrist={self.cam_wrist}, front={self.cam_front}")
        self.get_logger().info(
            "  전략: _cam_lock / _state_lock 분리 + copy()를 락 밖으로 이동"
        )

    # ── 모델 로드 ─────────────────────────────────────────────────────────────
    def _load_policy(self):
        try:
            self.policy = ACTPolicy.from_pretrained(self.model_path)
            self.policy.to(self.device)
            self.policy.eval()
            self.ensembler = ACTTemporalEnsembler(
                temporal_ensemble_coeff=0.2,
                chunk_size=self.policy.config.chunk_size
            )
            self.get_logger().info("✅ 정책 및 앙상블 로딩 완료")
        except Exception as e:
            self.get_logger().error(f"❌ 모델 로딩 실패: {e}")
            sys.exit(1)

    # ── 통계값 로드 ───────────────────────────────────────────────────────────
    def _load_stats(self):
        try:
            path = hf_hub_download(
                repo_id=self.dataset_repo, filename="meta/stats.json", repo_type="dataset"
            )
            with open(path, "r") as f:
                stats = json.load(f)

            self.state_mean  = torch.tensor(stats["observation.state"]["mean"]).to(self.device)
            self.state_std   = torch.tensor(stats["observation.state"]["std"]).to(self.device)
            self.action_mean = torch.tensor(stats["action"]["mean"]).to(self.device)
            self.action_std  = torch.tensor(stats["action"]["std"]).to(self.device)
            self.img_mean    = torch.tensor([0.5, 0.5, 0.5]).view(3, 1, 1).to(self.device)
            self.img_std     = torch.tensor([1.0, 1.0, 1.0]).view(3, 1, 1).to(self.device)
            self.get_logger().info("✅ stats.json 로드 완료")
        except Exception as e:
            self.get_logger().error(f"❌ stats.json 로드 실패: {e}")
            sys.exit(1)

    # ── ROS 콜백 ──────────────────────────────────────────────────────────────
    def _state_cb(self, msg: JointState):
        # ── 버전 2: 조인트 상태는 _state_lock만 사용 ────────────────────────
        with self._state_lock:
            self._latest_follower_state = list(msg.position[:6])

    # ── 로컬 카메라 루프 ──────────────────────────────────────────────────────
    def _cam_loop(self):
        cap_wrist = cv2.VideoCapture(self.cam_wrist)
        cap_front = cv2.VideoCapture(self.cam_front)

        for cap in (cap_wrist, cap_front):
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  IMG_W)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, IMG_H)
            cap.set(cv2.CAP_PROP_FPS,          FPS)

        if not cap_wrist.isOpened() or not cap_front.isOpened():
            self.get_logger().error(
                f"❌ 카메라 열기 실패! 포트 번호 확인: wrist={self.cam_wrist}, front={self.cam_front}"
            )
        else:
            self.get_logger().info(
                f"[카메라] wrist({self.cam_wrist}), front({self.cam_front}) 연결 성공"
            )

        while self._cam_running:
            ret_w, frame_w = cap_wrist.read()
            ret_f, frame_f = cap_front.read()

            if ret_w and ret_f:
                # ── 버전 2: 카메라 프레임은 _cam_lock만 사용 ────────────────
                # BGR→RGB 변환과 resize는 락 밖에서 수행해 락 점유 시간 최소화
                wrist_rgb = cv2.cvtColor(
                    cv2.resize(frame_w, (IMG_W, IMG_H)), cv2.COLOR_BGR2RGB
                )
                front_rgb = cv2.cvtColor(
                    cv2.resize(frame_f, (IMG_W, IMG_H)), cv2.COLOR_BGR2RGB
                )
                with self._cam_lock:
                    self._latest_wrist = wrist_rgb
                    self._latest_front = front_rgb
                # ────────────────────────────────────────────────────────────
            else:
                time.sleep(0.01)

        cap_wrist.release()
        cap_front.release()

    # ── 디스플레이 전용 스레드 ────────────────────────────────────────────────
    def _display_loop(self):
        while self._cam_running:
            # ── 버전 2: 디스플레이도 _cam_lock 사용 ─────────────────────────
            with self._cam_lock:
                front = self._latest_front
                wrist = self._latest_wrist
            # ────────────────────────────────────────────────────────────────

            if front is not None and wrist is not None:
                cv2.imshow("Front Camera", cv2.cvtColor(front, cv2.COLOR_RGB2BGR))
                cv2.imshow("Wrist Camera", cv2.cvtColor(wrist, cv2.COLOR_RGB2BGR))
                cv2.waitKey(1)
            else:
                time.sleep(0.01)

    # ── 추론 루프 (30Hz 타이머) ───────────────────────────────────────────────
    def _inference_loop(self):
        # ── 버전 2 핵심: 락을 분리하고 copy()를 락 밖으로 꺼냄 ──────────────

        # 1) 조인트 상태 읽기 (_state_lock, 짧게 유지)
        with self._state_lock:
            if self._latest_follower_state is None:
                return
            state = list(self._latest_follower_state)   # 리스트 복사 (즉시 완료)

        # 2) 카메라 프레임 참조만 가져오기 (_cam_lock, 짧게 유지)
        with self._cam_lock:
            if self._latest_front is None:
                return
            front_ref = self._latest_front   # 참조만 획득, copy는 락 밖에서
            wrist_ref = self._latest_wrist

        # 3) 락 해제 후 copy (640×480 numpy 복사가 락 점유 시간에서 제외됨)
        front = front_ref.copy()
        wrist = wrist_ref.copy()
        # ────────────────────────────────────────────────────────────────────

        # 전처리 (정규화) — 원본과 동일
        front_t = (
            torch.from_numpy(front).permute(2, 0, 1).float().to(self.device) / 255.0
            - self.img_mean
        ) / self.img_std
        wrist_t = (
            torch.from_numpy(wrist).permute(2, 0, 1).float().to(self.device) / 255.0
            - self.img_mean
        ) / self.img_std

        state_deg = [math.degrees(v) for v in state]
        state_t = (
            torch.tensor(state_deg, dtype=torch.float32).to(self.device) - self.state_mean
        ) / self.state_std

        obs = {
            "observation.images.front": front_t.unsqueeze(0),
            "observation.images.wrist": wrist_t.unsqueeze(0),
            "observation.state":        state_t.unsqueeze(0),
        }

        # 추론 및 앙상블 — 원본과 동일
        with torch.no_grad():
            action_chunk = self.policy.predict_action_chunk(obs)
            action = self.ensembler.update(action_chunk)

        # 역정규화 → radian 변환 → publish — 원본과 동일
        action_deg = (action.squeeze() * self.action_std) + self.action_mean
        action_rad = [math.radians(v) for v in action_deg.cpu().numpy().tolist()]

        msg = Float32MultiArray()
        msg.data = action_rad
        self.cmd_pub.publish(msg)

    # ── 종료 ─────────────────────────────────────────────────────────────────
    def destroy_node(self):
        self._cam_running = False
        cv2.destroyAllWindows()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = OMXInferenceNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()