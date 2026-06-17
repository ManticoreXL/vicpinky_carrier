#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import TwistStamped, PointStamped
import cv2
import numpy as np
import os
import onnxruntime as ort
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

output_frame = np.zeros((320, 320, 3), dtype=np.uint8)
lock = threading.Lock()

class StreamingHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global output_frame, lock
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=frame')
            self.end_headers()
            while True:
                with lock:
                    if output_frame is None:
                        time.sleep(0.03)
                        continue
                    img_to_encode = output_frame.copy()
                
                _, encoded_image = cv2.imencode('.jpg', img_to_encode, [int(cv2.IMWRITE_JPEG_QUALITY), 65])
                byte_frame = encoded_image.tobytes()
                
                try:
                    self.wfile.write(b'--frame\r\n')
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(byte_frame)))
                    self.end_headers()
                    self.wfile.write(byte_frame)
                    self.wfile.write(b'\r\n')
                    time.sleep(0.05)
                except Exception:
                    break
        else:
            self.send_response(404)
            self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True

class PeopleDetectorNode(Node):
    def __init__(self):
        super().__init__('people_detector_node')
        
        self.declare_parameter('device', 2)
        camera_device = self.get_parameter('device').value
        
        self.cmd_vel_pub = self.create_publisher(TwistStamped, '/cmd_vel', 10)
        self.person_pos_pub = self.create_publisher(PointStamped, '/detected_person/relative_pos', 10)
        
        self.get_logger().info("[YOLO]: 기절/미동(No-Motion) 요구조자 정밀 판정 노드 가동")

        current_dir = os.path.dirname(os.path.abspath(__file__))
        onnx_path = os.path.join(current_dir, 'best.onnx')
        try:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            self.ort_session = ort.InferenceSession(onnx_path, opts)
            self.get_logger().info(" ONNX 모델 로드 완료")
        except Exception as e:
            self.get_logger().error(f" ONNX 모델 로드 실패: {e}")
            return

        # 선언한 파라미터 변수를 장치 번호로 사용
        self.cap = cv2.VideoCapture(camera_device, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            self.get_logger().error(f" {camera_device}번 USB 웹캠을 열 수 없습니다!")
            return

        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 320)

        self.tracked_people = {}  
        self.next_person_id = 1
        
        self.timer = self.create_timer(0.5, self.process_rescue_sequence)

        self.server = ThreadedHTTPServer(('0.0.0.0', 5000), StreamingHandler)
        self.server_thread = threading.Thread(target=self.server.serve_forever)
        self.server_thread.daemon = True
        self.server_thread.start()

    def send_stop_signal(self):
        twist_msg = TwistStamped()
        twist_msg.header.stamp = self.get_clock().now().to_msg()
        twist_msg.header.frame_id = 'tb3_04/base_link'
        twist_msg.twist.linear.x = 0.0
        twist_msg.twist.angular.z = 0.0
        self.cmd_vel_pub.publish(twist_msg)

    def process_rescue_sequence(self):
        global output_frame, lock
        if not hasattr(self, 'ort_session') or not self.cap.isOpened():
            return

        for _ in range(4):
            self.cap.grab()
            
        ret, frame = self.cap.read()
        if not ret or frame is None:
            return

        vis_frame = cv2.resize(frame, (320, 320))
        blob = cv2.cvtColor(vis_frame, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)
        blob = np.expand_dims(blob, axis=0).astype(np.float32) / 255.0

        outputs = self.ort_session.run(None, {self.ort_session.get_inputs()[0].name: blob})
        output_data = np.squeeze(outputs[0]).T

        CONF_THRESHOLD = 0.35
        IOU_THRESHOLD = 0.45 
        
        boxes = []
        confidences = []
        centers = []

        for row in output_data:
            confidence = float(row[4])
            if confidence > CONF_THRESHOLD:
                x_c, y_c, w_b, h_b = float(row[0]), float(row[1]), float(row[2]), float(row[3])
                
                img_x = int(x_c - w_b / 2)
                img_y = int(y_c - h_b / 2)
                
                boxes.append([img_x, img_y, int(w_b), int(h_b)])
                confidences.append(confidence)
                
                target_x = (x_c / 160.0) - 1.0
                target_y = (y_c / 160.0) - 1.0
                centers.append((target_x, target_y))

        indices = cv2.dnn.NMSBoxes(boxes, confidences, CONF_THRESHOLD, IOU_THRESHOLD)
        
        current_frame_detections = []
        if len(indices) > 0:
            for i in indices.flatten():
                current_frame_detections.append({
                    "x": centers[i][0], "y": centers[i][1], "conf": confidences[i], "box": boxes[i]
                })

        updated_ids = set()
        any_active_braking = False
        current_time = time.time()

        for det in current_frame_detections:
            matched_id = None
            min_dist = 0.35 

            for pid, pdata in self.tracked_people.items():
                dist = np.sqrt((det["x"] - pdata["last_x"])**2 + (det["y"] - pdata["last_y"])**2)
                if dist < min_dist:
                    min_dist = dist
                    matched_id = pid

            if matched_id is None:
                matched_id = self.next_person_id
                self.next_person_id += 1
                self.tracked_people[matched_id] = {
                    "last_x": det["x"], "last_y": det["y"], 
                    "first_still_time": current_time,
                    "last_seen": current_time,
                    "is_moving": False,
                    "sent_to_pc": False, "box": det["box"]
                }
            else:
                move_distance = np.sqrt((det["x"] - self.tracked_people[matched_id]["last_x"])**2 + 
                                       (det["y"] - self.tracked_people[matched_id]["last_y"])**2)
                
                self.tracked_people[matched_id]["last_x"] = det["x"]
                self.tracked_people[matched_id]["last_y"] = det["y"]
                self.tracked_people[matched_id]["box"] = det["box"]
                self.tracked_people[matched_id]["last_seen"] = current_time

                if move_distance > 0.05 and not self.tracked_people[matched_id]["sent_to_pc"]:
                    self.tracked_people[matched_id]["first_still_time"] = current_time
                    self.tracked_people[matched_id]["is_moving"] = True
                else:
                    self.tracked_people[matched_id]["is_moving"] = False

            updated_ids.add(matched_id)

            still_duration = current_time - self.tracked_people[matched_id]["first_still_time"]
            bx, by, bw, bh = self.tracked_people[matched_id]["box"]
            
            if self.tracked_people[matched_id]["sent_to_pc"]:
                p_status = "STILL (UNCONSCIOUS)"
                box_color = (255, 0, 0)
            elif self.tracked_people[matched_id]["is_moving"]:
                p_status = "MOVING (PASS)"
                box_color = (0, 0, 255)
            else:
                p_status = f"STILL: {min(5.0, still_duration):.1f}s / 5.0s"
                box_color = (0, 255, 0)
                any_active_braking = True

            cv2.rectangle(vis_frame, (bx, by), (bx + bw, by + bh), box_color, 2)
            cv2.putText(vis_frame, f"ID_{matched_id} [{p_status}]", (bx, max(by - 5, 15)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, box_color, 2)

            if still_duration >= 5.0 and not self.tracked_people[matched_id]["sent_to_pc"] and not self.tracked_people[matched_id]["is_moving"]:
                self.tracked_people[matched_id]["sent_to_pc"] = True
                
                point_msg = PointStamped()
                point_msg.header.stamp = self.get_clock().now().to_msg()
                point_msg.header.frame_id = f"tb3_04/person_{matched_id}" 
                point_msg.point.x = det["x"]
                point_msg.point.y = det["y"]
                point_msg.point.z = det["conf"]
                self.person_pos_pub.publish(point_msg)
                self.get_logger().error(f" [ID {matched_id}] 5초간 미동 없음 확인! 기절한 요구조자로 판단하여 관제 PC 송신!")

        all_ids = list(self.tracked_people.keys())
        for pid in all_ids:
            if pid not in updated_ids:
                if current_time - self.tracked_people[pid]["last_seen"] > 1.0:
                    del self.tracked_people[pid]
                    self.get_logger().warn(f" [ID {pid}] 화면 이탈 리셋.")
                else:
                    if not self.tracked_people[pid]["sent_to_pc"] and not self.tracked_people[pid]["is_moving"]:
                        any_active_braking = True
                    
                    bx, by, bw, bh = self.tracked_people[pid]["box"]
                    box_color = (255, 0, 0) if self.tracked_people[pid]["sent_to_pc"] else (0, 255, 0)
                    cv2.rectangle(vis_frame, (bx, by), (bx + bw, by + bh), box_color, 2)

        if any_active_braking:
            self.send_stop_signal()

        with lock:
            output_frame = vis_frame.copy()

def main(args=None):
    rclpy.init(args=args)
    node = PeopleDetectorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()