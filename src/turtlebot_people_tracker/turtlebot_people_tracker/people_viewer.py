#!/usr/bin/env python3
# =====================================================================
# people_viewer.py  (PC 측 사람 검출 코어 + 로컬 뷰어)
#
# 설계 원칙: "코어 한 번, 출처/출력은 갈아끼우기"
#   - PersonDetector : 프레임 -> 정규화 검출결과(박스 0~1 + 신뢰도).  ← 코어. 안 바뀜.
#   - 프레임 출처     : cv2.VideoCapture (로컬캠 0 / MJPEG·RTSP URL).  나중에 WebRTC 소비자로 교체.
#   - 출력 sink       : 지금=cv2 창에 박스 그리기(나만 봄).
#                       나중=detections_to_payload() 결과를 서버로 emit -> 브라우저가
#                            기존 WebRTC 영상 위에 박스만 덧그림(영상 재송출 불필요).
#
# 박스는 전부 '정규화(0~1)'로 들고 다님 -> 해상도 무관 -> 로컬 창이든 브라우저든 그대로 맞음.
#
# 실행 예:
#   python3 people_viewer.py --source 0                       # PC 로컬 웹캠으로 코어 테스트
#   python3 people_viewer.py --source http://<robot_ip>:5000  # 로봇 MJPEG 스트림
# =====================================================================
import argparse
import time

import cv2
import numpy as np
import onnxruntime as ort


# ── 검출 코어 ─────────────────────────────────────────────────────────────────

class Detection:
    """정규화 검출 결과. x,y,w,h 는 프레임 대비 0~1 비율(좌상단+크기)."""
    __slots__ = ("x", "y", "w", "h", "conf")

    def __init__(self, x, y, w, h, conf):
        self.x, self.y, self.w, self.h, self.conf = x, y, w, h, conf

    def to_px(self, frame_w, frame_h):
        """현재 프레임 픽셀 좌표 (x1,y1,x2,y2) 로 변환."""
        x1 = int(self.x * frame_w)
        y1 = int(self.y * frame_h)
        x2 = int((self.x + self.w) * frame_w)
        y2 = int((self.y + self.h) * frame_h)
        return x1, y1, x2, y2


class PersonDetector:
    """
    프레임(BGR) -> [Detection, ...].  프레임 출처가 무엇이든 동일하게 동작.
    모델: 단일클래스 YOLOv8 ONNX (입력 [1,3,imgsz,imgsz], 출력 [1,5,N]).
    """
    def __init__(self, model_path, imgsz=320, conf_th=0.35, iou_th=0.45, threads=2):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(model_path, opts)
        self.iname = self.sess.get_inputs()[0].name
        self.imgsz = imgsz
        self.conf_th = conf_th
        self.iou_th = iou_th

    def detect(self, frame_bgr):
        s = self.imgsz
        # 전처리: imgsz 정사각 리사이즈(스쿼시) -> RGB -> CHW -> /255
        # (스쿼시라 정규화는 /imgsz 한 번이면 프레임 전체 대비 0~1 비율이 됨.
        #  비정사각 프레임에서 더 정확히 하려면 letterbox 로 바꾸면 됨.)
        img = cv2.resize(frame_bgr, (s, s))
        blob = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)
        blob = np.expand_dims(blob, 0).astype(np.float32) / 255.0

        out = self.sess.run(None, {self.iname: blob})[0]   # [1,5,N]
        rows = np.squeeze(out).T                            # [N,5] = [cx,cy,w,h,conf] (imgsz 픽셀 공간)

        boxes, confs = [], []
        for r in rows:
            c = float(r[4])
            if c <= self.conf_th:
                continue
            cx, cy, w, h = float(r[0]), float(r[1]), float(r[2]), float(r[3])
            boxes.append([int(cx - w / 2), int(cy - h / 2), int(w), int(h)])  # NMS용 좌상단+크기(픽셀)
            confs.append(c)

        dets = []
        if boxes:
            idxs = cv2.dnn.NMSBoxes(boxes, confs, self.conf_th, self.iou_th)
            for i in np.array(idxs).flatten():
                bx, by, bw, bh = boxes[i]
                # imgsz 픽셀 -> 0~1 정규화 (프레임 전체 대비 비율)
                dets.append(Detection(bx / s, by / s, bw / s, bh / s, confs[i]))
        return dets


# ── 출력 sink ─────────────────────────────────────────────────────────────────

def draw_detections(frame, dets):
    """로컬 보기용: 프레임에 박스+신뢰도 그림."""
    h, w = frame.shape[:2]
    for d in dets:
        x1, y1, x2, y2 = d.to_px(w, h)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(frame, f"person {d.conf:.2f}", (x1, max(y1 - 6, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
    return frame


def detections_to_payload(dets):
    """
    서버로 보낼 때 쓸 형태(정규화 좌표). 지금은 호출 안 하지만, 나중에
    socketio 로 이 리스트만 emit 하면 브라우저가 자기 영상 위에 박스 덧그릴 수 있음.
    """
    return [{"x": d.x, "y": d.y, "w": d.w, "h": d.h, "conf": round(d.conf, 3)}
            for d in dets]


# ── 프레임 출처 ───────────────────────────────────────────────────────────────

def open_source(source):
    """source 가 정수면 로컬캠, 문자열이면 URL(MJPEG/RTSP/http). 둘 다 VideoCapture 로 처리."""
    cap = cv2.VideoCapture(int(source)) if str(source).isdigit() else cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"영상 출처 열기 실패: {source}")
    return cap

# (나중에 WebRTC 소비자로 받을 때는 위 cap.read() 대신 aiortc track.recv() ->
#  frame.to_ndarray(format='bgr24') 로 프레임만 공급하면 코어/그리기는 그대로 재사용.)


# ── 메인 루프 ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="PC 사람 검출 뷰어")
    ap.add_argument("--source", default="0", help="0=로컬캠, 또는 http://<robot_ip>:<port> MJPEG URL")
    ap.add_argument("--model", default="best.onnx")
    ap.add_argument("--imgsz", type=int, default=320)
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--no-show", action="store_true", help="창 없이(검출만)")
    args = ap.parse_args()

    detector = PersonDetector(args.model, args.imgsz, args.conf, args.iou)
    cap = open_source(args.source)
    print(f"[people_viewer] source={args.source} model={args.model} | q 로 종료")

    prev, fps = time.time(), 0.0
    while True:
        ret, frame = cap.read()
        if not ret or frame is None:
            print("프레임 수신 실패 — 종료"); break

        dets = detector.detect(frame)

        # --- 지금: 로컬 sink (나만 보기) ---
        if not args.no_show:
            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev, 1e-6)); prev = now
            draw_detections(frame, dets)
            cv2.putText(frame, f"{fps:4.1f} fps | {len(dets)} person",
                        (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            cv2.imshow("people_viewer", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        # --- 나중: 서버 sink (여기서 detections_to_payload(dets) 를 emit) ---
        # payload = detections_to_payload(dets)
        # sio.emit("person_detections", {"botId": "tb3_01", "boxes": payload})

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
