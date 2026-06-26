#!/usr/bin/env python3
"""
victim_detector  (라파이 측 실행 / 추론 전용)

역할:
  로컬 카메라 영상을 받아 YOLO(ONNX, person 단일 클래스)로 사람을 탐지하고,
  '이미지 속 bbox(픽셀) + score' 만 vision_msgs/Detection2DArray 로 발행한다.
  ※ map 좌표 변환(바닥 투영)·확정·마커·CSV 는 하지 않는다 → PC 의 victim_mapper 담당.

토픽:
  (구독) <image_topic>        sensor_msgs/CompressedImage    로컬 카메라 압축 영상
  (발행) <detections_topic>   vision_msgs/Detection2DArray   bbox(원본 픽셀) + score
         header.stamp    = 촬영 시각(이미지 stamp 보존; PC 가 이 시각으로 TF 조회)
         header.frame_id = camera_frame (광학 프레임)

의존성:  onnxruntime, opencv-python(cv2), numpy, vision_msgs
  (vision_msgs:  sudo apt install ros-$ROS_DISTRO-vision-msgs)
"""

import os
import datetime

import numpy as np
import cv2
import onnxruntime as ort

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy, QoSDurabilityPolicy

from sensor_msgs.msg import CompressedImage
from vision_msgs.msg import Detection2D, Detection2DArray, BoundingBox2D, ObjectHypothesisWithPose
from geometry_msgs.msg import PoseStamped


class VictimDetector(Node):
    def __init__(self):
        super().__init__('victim_detector')

        # ---- 파라미터 ----
        self.declare_parameter('model_path', os.path.expanduser('~/models/best.onnx'))
        self.declare_parameter('image_topic', '/image_raw/compressed')
        self.declare_parameter('detections_topic', '/victim/detections')
        self.declare_parameter('camera_frame', 'camera_optical_frame')
        self.declare_parameter('input_size', 320)        # 모델 imgsz (best.onnx = 320)
        self.declare_parameter('conf_threshold', 0.45)   # YOLO 점수 임계
        self.declare_parameter('nms_iou', 0.5)
        self.declare_parameter('process_interval', 0.1)  # 추론 최소 간격(초) = 최대 ~10Hz

        # ---- 조난자 확정 스냅샷 ----
        #   PC 의 victim_mapper 가 /victim/confirmed 를 내면, 그 순간의 카메라
        #   최신 프레임 1장을 jpg 로 저장(victims.csv 옆). 대역폭 절약 위해
        #   이미지는 PC 로 안 보내고 로봇 로컬에 저장.
        self.declare_parameter('enable_snapshot', True)
        self.declare_parameter('confirmed_topic', '/victim/confirmed')
        self.declare_parameter('snapshot_dir', os.path.expanduser('~/maps'))
        self.declare_parameter('snapshot_prefix', 'victim')   # 파일명 접두어
        self.declare_parameter('publish_snapshot', True)      # 서버 확인용 이미지 토픽 발행
        self.declare_parameter('snapshot_topic', '/victim/snapshot')
        self.declare_parameter('snapshot_jpeg_quality', 80)   # jpg 압축 품질(1~100)
        self.declare_parameter('debug_log', True)             # 진단 로그(프레임 수신/추론결과) 출력

        g = self.get_parameter
        self.camera_frame = g('camera_frame').value
        self.input_size = int(g('input_size').value)
        self.conf_thr = float(g('conf_threshold').value)
        self.nms_iou = float(g('nms_iou').value)
        self.process_interval = float(g('process_interval').value)

        self.enable_snapshot = bool(g('enable_snapshot').value)
        self.snapshot_dir = g('snapshot_dir').value
        self.snapshot_prefix = g('snapshot_prefix').value
        self.publish_snapshot = bool(g('publish_snapshot').value)
        self.snapshot_jpeg_quality = int(g('snapshot_jpeg_quality').value)
        self.debug_log = bool(g('debug_log').value)
        self._frame_count = 0          # 받은 프레임 누계(진단용)

        # ---- ONNX 세션 (라파이 = CPU. 가속기 쓰면 providers 변경) ----
        model_path = g('model_path').value
        self.session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        self.get_logger().info(f'ONNX 로드 완료: {model_path}')

        self.last_proc_time = None
        self._last_frame = None        # 최신 디코드 프레임(BGR) 보관 — 스냅샷용
        self._snap_count = 0           # 저장한 스냅샷 수(파일 순번)

        sensor_qos = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.BEST_EFFORT,
                                history=QoSHistoryPolicy.KEEP_LAST)
        self.create_subscription(CompressedImage, g('image_topic').value, self._image_cb, sensor_qos)
        self.pub_det = self.create_publisher(Detection2DArray, g('detections_topic').value, 10)

        # ---- 확정 스냅샷: /victim/confirmed 구독 ----
        if self.enable_snapshot:
            try:
                os.makedirs(self.snapshot_dir, exist_ok=True)
            except OSError as e:
                self.get_logger().warn(f'스냅샷 폴더 생성 실패({self.snapshot_dir}): {e}')
            self.create_subscription(
                PoseStamped, g('confirmed_topic').value, self._confirmed_cb, 10)
            self.get_logger().info(
                f'확정 스냅샷 활성화 → {self.snapshot_dir}/{self.snapshot_prefix}_*.jpg')

            # 서버 확인용 이미지 토픽(latched: 늦게 붙은 구독자도 마지막 사진 수신)
            self.pub_snapshot = None
            if self.publish_snapshot:
                snap_qos = QoSProfile(
                    depth=1,
                    reliability=QoSReliabilityPolicy.RELIABLE,
                    durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                    history=QoSHistoryPolicy.KEEP_LAST,
                )
                self.pub_snapshot = self.create_publisher(
                    CompressedImage, g('snapshot_topic').value, snap_qos)
                self.get_logger().info(
                    f'스냅샷 이미지 토픽 발행 → {g("snapshot_topic").value} (CompressedImage/jpeg)')

        self.get_logger().info('victim_detector(추론) 시작. 카메라 영상 대기 중...')

    def _image_cb(self, msg):
        now = self.get_clock().now()
        if self.last_proc_time is not None:
            if (now - self.last_proc_time).nanoseconds / 1e9 < self.process_interval:
                return
        self.last_proc_time = now

        buf = np.frombuffer(msg.data, dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)   # BGR
        if frame is None:
            if self.debug_log:
                self.get_logger().warn('프레임 디코드 실패(빈/손상 데이터).',
                                       throttle_duration_sec=2.0)
            return
        self._last_frame = frame      # 스냅샷용 최신 프레임 보관

        # [진단] 카메라 프레임이 들어오고 있다는 표시 (2초마다 1회)
        self._frame_count += 1
        if self.debug_log:
            h, w = frame.shape[:2]
            self.get_logger().info(
                f'[카메라] 프레임 수신 중 (누계 {self._frame_count}, 해상도 {w}x{h})',
                throttle_duration_sec=2.0)

        dets = self._infer(frame)   # [(x1,y1,x2,y2,score), ...] 원본 픽셀 좌표

        # [진단] 추론 결과: 사람 몇 명 잡았는지
        if self.debug_log:
            if dets:
                top = max(s for *_, s in dets)
                self.get_logger().info(
                    f'[추론] 사람 {len(dets)}명 탐지 (최고 score {top:.2f}) → 발행',
                    throttle_duration_sec=1.0)
            else:
                self.get_logger().info(
                    '[추론] 사람 0명 (영상은 들어오나 탐지 없음)',
                    throttle_duration_sec=2.0)

        if not dets:
            return                  # 탐지 없으면 발행 안 함 (PC 타임아웃은 PC 타이머가 처리)

        arr = Detection2DArray()
        arr.header.stamp = msg.header.stamp          # 촬영 시각 보존(중요)
        arr.header.frame_id = self.camera_frame
        for (x1, y1, x2, y2, score) in dets:
            d = Detection2D()
            d.header = arr.header
            bb = BoundingBox2D()
            bb.center.position.x = float((x1 + x2) / 2.0)
            bb.center.position.y = float((y1 + y2) / 2.0)
            bb.center.theta = 0.0
            bb.size_x = float(x2 - x1)
            bb.size_y = float(y2 - y1)
            d.bbox = bb
            hyp = ObjectHypothesisWithPose()
            hyp.hypothesis.class_id = 'person'
            hyp.hypothesis.score = float(score)
            d.results.append(hyp)
            arr.detections.append(d)
        self.pub_det.publish(arr)

    # ==================================================================
    # 확정 스냅샷: /victim/confirmed 수신 시 최신 프레임 1장 저장
    # ==================================================================
    def _confirmed_cb(self, msg: PoseStamped):
        if not self.enable_snapshot:
            return
        if self._last_frame is None:
            self.get_logger().warn('확정 신호 수신했으나 보관된 카메라 프레임이 없음 — 스냅샷 생략.')
            return
        x = msg.pose.position.x
        y = msg.pose.position.y
        self._snap_count += 1
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        # 파일명: victim_001_x3.61_y1.21_20260626_114501.jpg
        fname = (f'{self.snapshot_prefix}_{self._snap_count:03d}'
                 f'_x{x:.2f}_y{y:.2f}_{ts}.jpg')
        path = os.path.join(self.snapshot_dir, fname)
        try:
            ok = cv2.imwrite(path, self._last_frame)
            if ok:
                self.get_logger().info(f'★ 조난자 스냅샷 저장: {path}')
            else:
                self.get_logger().error(f'스냅샷 저장 실패(cv2.imwrite False): {path}')
        except Exception as e:
            self.get_logger().error(f'스냅샷 저장 오류: {e}')

        # 서버 확인용: 같은 프레임을 CompressedImage(jpeg)로 발행
        if self.publish_snapshot and self.pub_snapshot is not None:
            try:
                enc = [int(cv2.IMWRITE_JPEG_QUALITY), self.snapshot_jpeg_quality]
                ok2, jpg = cv2.imencode('.jpg', self._last_frame, enc)
                if ok2:
                    out = CompressedImage()
                    # 확정 좌표 시각을 보존(서버가 좌표·사진 매칭에 사용 가능)
                    out.header.stamp = msg.header.stamp
                    out.header.frame_id = self.camera_frame
                    out.format = 'jpeg'
                    out.data = jpg.tobytes()
                    self.pub_snapshot.publish(out)
                    self.get_logger().info(
                        f'스냅샷 토픽 발행 ({len(out.data)//1024} KB).')
                else:
                    self.get_logger().error('스냅샷 jpeg 인코딩 실패.')
            except Exception as e:
                self.get_logger().error(f'스냅샷 토픽 발행 오류: {e}')

    # ==================================================================
    # YOLO 추론 + 후처리 (NMS 직접)  — 원본과 동일
    # ==================================================================
    def _infer(self, frame):
        s = self.input_size
        h0, w0 = frame.shape[:2]
        r = min(s / h0, s / w0)
        nw, nh = int(round(w0 * r)), int(round(h0 * r))
        left, top = (s - nw) // 2, (s - nh) // 2

        canvas = np.full((s, s, 3), 114, dtype=np.uint8)
        canvas[top:top + nh, left:left + nw] = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.session.run(None, {self.input_name: blob})[0]   # [1,5,N]
        pred = out[0].T                                            # [N,5] : cx,cy,w,h,score
        scores = pred[:, 4]
        keep = scores > self.conf_thr
        pred = pred[keep]
        scores = scores[keep]
        if pred.shape[0] == 0:
            return []

        cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
        x1 = cx - w / 2; y1 = cy - h / 2; x2 = cx + w / 2; y2 = cy + h / 2

        boxes_wh = np.stack([x1, y1, w, h], axis=1).tolist()
        idxs = cv2.dnn.NMSBoxes(boxes_wh, scores.tolist(), self.conf_thr, self.nms_iou)
        if len(idxs) == 0:
            return []
        idxs = np.array(idxs).flatten()

        dets = []
        for i in idxs:
            ox1 = (x1[i] - left) / r; oy1 = (y1[i] - top) / r
            ox2 = (x2[i] - left) / r; oy2 = (y2[i] - top) / r
            ox1 = max(0.0, min(w0 - 1, ox1)); ox2 = max(0.0, min(w0 - 1, ox2))
            oy1 = max(0.0, min(h0 - 1, oy1)); oy2 = max(0.0, min(h0 - 1, oy2))
            dets.append((ox1, oy1, ox2, oy2, float(scores[i])))
        return dets


def main(args=None):
    rclpy.init(args=args)
    node = VictimDetector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
