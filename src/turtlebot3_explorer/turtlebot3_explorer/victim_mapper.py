#!/usr/bin/env python3
"""
victim_mapper  (PC 측 실행)

역할:
  라파이 victim_detector 가 발행한 bbox(픽셀)를 받아, camera_info + TF 로
  '바닥 평면 투영'하여 map 좌표를 추정한다. 사람이 보이면 coordinator 에 '정지'를
  요청하고, 정지 상태에서 여러 프레임을 모아 위치가 일관되면 '확정' → RViz 마커 + CSV.
  같은 사람은 다시 안 멈춘다. (= 예전 통합 detector 의 '뒷부분'을 PC 로 분리)

토픽:
  (구독) <detections_topic>  vision_msgs/Detection2DArray   라파이 추론 결과(bbox + stamp + frame)
         <camera_info_topic> sensor_msgs/CameraInfo          내부파라미터(보정값; 라파이 카메라가 발행)
  (발행) /victim/candidate   std_msgs/Empty                  "사람 보임 → 멈춰"
         /victim/confirmed   geometry_msgs/PoseStamped       확정 위치(map)
         /victim/rejected    std_msgs/Empty                  "오탐 → 다시 가"
         /victim/markers     visualization_msgs/MarkerArray  (RViz, latched)
         /victim/list        geometry_msgs/PoseArray         확정 목록(coordinator 회피용, latched)

전제:
  1) camera_info 가 실제 fx,fy,cx,cy (보정값) 를 담고 있을 것.
  2) map -> camera_frame TF 존재(카메라 장착 높이/각도 static TF).
  3) 바닥이 평평(map z=0).

의존성:  numpy, vision_msgs, tf2_ros
"""

import os
import csv
import json
import math

import numpy as np

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy, QoSHistoryPolicy

from std_msgs.msg import Empty, ColorRGBA, String
from sensor_msgs.msg import CameraInfo
from geometry_msgs.msg import PoseStamped, PoseArray, Pose, Point, Vector3
from visualization_msgs.msg import Marker, MarkerArray
from vision_msgs.msg import Detection2DArray

import tf2_ros
from tf2_ros import TransformException


class VictimMapper(Node):
    IDLE = 'IDLE'
    CONFIRMING = 'CONFIRMING'
    COOLDOWN = 'COOLDOWN'

    def __init__(self):
        super().__init__('victim_mapper')

        # ---- 파라미터 ----
        self.declare_parameter('detections_topic', '/victim/detections')
        self.declare_parameter('camera_info_topic', '/camera_info')
        self.declare_parameter('camera_frame', 'camera_optical_frame')
        self.declare_parameter('map_frame', 'map')

        self.declare_parameter('min_confirm_frames', 6)  # 정지 상태에서 모아야 하는 일관된 추정 수
        self.declare_parameter('confirm_timeout', 6.0)   # 이 시간 내 확정 못하면 오탐 처리(초)
        self.declare_parameter('max_spread', 0.5)        # 추정들이 이보다 흩어지면 확정 보류(m)
        self.declare_parameter('merge_radius', 1.0)      # 이 반경 내 기존 victim 과는 같은 사람(m)
        self.declare_parameter('cooldown_time', 4.0)     # 오탐 후 재트리거 억제(초)

        self.declare_parameter('uncert_base', 0.20)      # 불확실성 반경 r = base + slope*거리
        self.declare_parameter('uncert_slope', 0.10)
        self.declare_parameter('max_range', 6.0)         # 이보다 먼 추정은 신뢰 안 함(m)

        # ---- 폴백(바닥 교차 실패 시): bbox 높이/너비 동적 기반 거리추정 + 클램프 ----
        self.declare_parameter('enable_fallback', True)
        self.declare_parameter('assumed_person_height', 1.6)  # 사람의 몸길이/키 기준값(m)
        self.declare_parameter('fallback_range', 2.5)        # bbox 추정 불가 시 기본 거리(m)
        self.declare_parameter('fallback_min_range', 1.0)    # 거리추정 하한(m)
        self.declare_parameter('fallback_max_range', 4.0)    # 거리추정 상한(m)
        self.declare_parameter('fallback_uncert', 1.5)       # 폴백 점의 불확실성 반경(m)

        self.declare_parameter('csv_path', os.path.expanduser('~/maps/victims.csv'))

        g = self.get_parameter
        self.camera_frame = g('camera_frame').value
        self.map_frame = g('map_frame').value
        self.min_confirm = int(g('min_confirm_frames').value)
        self.confirm_timeout = float(g('confirm_timeout').value)
        self.max_spread = float(g('max_spread').value)
        self.merge_radius = float(g('merge_radius').value)
        self.cooldown_time = float(g('cooldown_time').value)
        self.uncert_base = float(g('uncert_base').value)
        self.uncert_slope = float(g('uncert_slope').value)
        self.max_range = float(g('max_range').value)
        self.enable_fallback = bool(g('enable_fallback').value)
        self.assumed_person_height = float(g('assumed_person_height').value)
        self.fallback_range = float(g('fallback_range').value)
        self.fallback_min_range = float(g('fallback_min_range').value)
        self.fallback_max_range = float(g('fallback_max_range').value)
        self.fallback_uncert = float(g('fallback_uncert').value)
        self.csv_path = g('csv_path').value

        # ---- TF ----
        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        # ---- 상태 ----
        self.K = None                 # 카메라 내부파라미터 (fx,fy,cx,cy)
        self.state = self.IDLE
        self.estimates = []           # CONFIRMING 중 모은 [(x,y,dist), ...]
        self.confirm_start = None
        self.cooldown_until = None
        self.victims = []             # 확정된 [(x, y, uncert_radius), ...]

        # ---- 구독/발행 ----
        latched = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.RELIABLE,
                             durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                             history=QoSHistoryPolicy.KEEP_LAST)
        sensor_qos = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.BEST_EFFORT,
                                history=QoSHistoryPolicy.KEEP_LAST)

        self.create_subscription(CameraInfo, g('camera_info_topic').value, self._camera_info_cb, sensor_qos)
        self.create_subscription(Detection2DArray, g('detections_topic').value, self._det_cb, 10)

        self.pub_candidate = self.create_publisher(Empty, '/victim/candidate', 10)
        self.pub_confirmed = self.create_publisher(PoseStamped, '/victim/confirmed', 10)
        self.pub_rejected = self.create_publisher(Empty, '/victim/rejected', 10)
        self.pub_markers = self.create_publisher(MarkerArray, '/victim/markers', latched)
        self.pub_list = self.create_publisher(PoseArray, '/victim/list', latched)
        self.pub_report = self.create_publisher(String, '/victim/report', latched)

        # 메시지 도착과 무관하게 타임아웃/쿨다운을 갱신하는 타이머(5Hz)
        self.create_timer(0.2, self._tick)

        self.get_logger().info('victim_mapper 시작. detections / camera_info 대기 중...')

    # ==================================================================
    # 콜백
    # ==================================================================
    def _camera_info_cb(self, msg):
        if self.K is None:
            fx, fy, cx, cy = msg.k[0], msg.k[4], msg.k[2], msg.k[5]
            self.K = (fx, fy, cx, cy)
            self.get_logger().info(f'내부파라미터 수신: fx={fx:.1f} fy={fy:.1f} cx={cx:.1f} cy={cy:.1f}')

    def _tick(self):
        """ 메시지가 끊겨도 타임아웃/쿨다운이 진행되도록 주기적으로 점검 """
        now = self.get_clock().now()
        if self.state == self.COOLDOWN and self.cooldown_until is not None and now >= self.cooldown_until:
            self.state = self.IDLE
        self._check_confirm_timeout(now)

    def _det_cb(self, msg):
        n = len(msg.detections)
        if self.K is None:
            self.get_logger().warn(f'[det] {n}개 수신했지만 camera_info 미수신 → 투영 불가',
                                   throttle_duration_sec=3.0)
            return
        self.get_logger().info(f'[det] {n}개 수신 (state={self.state})', throttle_duration_sec=1.0)
        if self.state == self.COOLDOWN:
            self.get_logger().info('[det] COOLDOWN 중 → 무시', throttle_duration_sec=2.0)
            return

        stamp = msg.header.stamp
        cand = []
        reasons = []
        for d in msg.detections:
            bb = d.bbox
            u = bb.center.position.x
            v = bb.center.position.y + bb.size_y / 2.0   # bbox 하단(발 접점 가정)
            w_px = bb.size_x                             # bbox 픽셀 너비 (누운 사람 고려)
            h_px = bb.size_y                             # bbox 픽셀 높이 (서 있는 사람 고려)
            
            est, reason = self._project_to_ground(u, v, w_px, h_px, stamp)
            if est is None:
                reasons.append(reason)
                continue
            mx, my, dist, radius, method = est
            cand.append((mx, my, dist, radius, method))

        if not cand:
            self.get_logger().warn(f'[det] 후보 0건 — 사유: {reasons}', throttle_duration_sec=1.0)
            return

        # 정확(ground) 후보를 우선, 그 안에서 가까운 것. ground 없으면 fallback 중 가까운 것.
        cand.sort(key=lambda c: (0 if c[4] == 'ground' else 1, c[2]))
        mx, my, dist, radius, method = cand[0]
        tag = '정확(바닥교차)' if method == 'ground' else '추정(동적크기)'
        self.get_logger().info(f'[det] 후보 채택 [{tag}] map=({mx:.2f},{my:.2f}) dist={dist:.2f}m r={radius:.2f}m')

        if self._near_known(mx, my):      # 이미 아는 victim 근처면 무시
            self.get_logger().info('[det] 기존 victim 근처 → 무시', throttle_duration_sec=2.0)
            return

        now = self.get_clock().now()
        if self.state == self.IDLE:
            self.get_logger().warn(f'사람 후보 감지 [{tag}] ({mx:.2f},{my:.2f}) → 정지 요청')
            self.pub_candidate.publish(Empty())
            self.state = self.CONFIRMING
            self.estimates = [(mx, my, dist, radius, method)]
            self.confirm_start = now
        elif self.state == self.CONFIRMING:
            self.estimates.append((mx, my, dist, radius, method))
            self.get_logger().info(f'[det] 확정 진행 {len(self.estimates)}/{self.min_confirm}',
                                   throttle_duration_sec=0.5)
            self._try_confirm(now)

    # ==================================================================
    # 확정 로직
    # ==================================================================
    def _try_confirm(self, now):
        if len(self.estimates) < self.min_confirm:
            self._check_confirm_timeout(now)
            return
        pts = np.array([(e[0], e[1]) for e in self.estimates])
        centroid = pts.mean(axis=0)
        spread = float(np.sqrt(((pts - centroid) ** 2).sum(axis=1)).max())

        # 다수결로 method 결정: 하나라도 ground 면 ground 취급(더 정확)
        methods = [e[4] for e in self.estimates]
        method = 'ground' if 'ground' in methods else 'fallback'

        # 폴백은 방향 추정이라 본질적으로 더 흩어짐 → spread 허용치를 폴백 반경 기준으로 완화
        spread_limit = self.max_spread if method == 'ground' else max(self.max_spread, self.fallback_uncert)
        if spread > spread_limit:
            self.estimates = self.estimates[-self.min_confirm:]
            self._check_confirm_timeout(now)
            return

        dist = float(np.median([e[2] for e in self.estimates]))
        if method == 'ground':
            radius = self.uncert_base + self.uncert_slope * dist
        else:
            radius = self.fallback_uncert
        self._register_victim(centroid[0], centroid[1], radius, method)

    def _check_confirm_timeout(self, now):
        if self.state != self.CONFIRMING or self.confirm_start is None:
            return
        if (now - self.confirm_start).nanoseconds / 1e9 > self.confirm_timeout:
            self.get_logger().warn('확정 실패(일관성/타임아웃) → 오탐 처리, 주행 재개.')
            self.pub_rejected.publish(Empty())
            self._enter_cooldown(now)

    def _enter_cooldown(self, now):
        self.state = self.COOLDOWN
        self.cooldown_until = now + rclpy.duration.Duration(seconds=self.cooldown_time)
        self.estimates = []
        self.confirm_start = None

    def _register_victim(self, x, y, radius, method='ground'):
        self.victims.append((float(x), float(y), float(radius), method))
        tag = '정확' if method == 'ground' else '추정구역'
        self.get_logger().warn(
            f'★ 조난자 확정 #{len(self.victims)} [{tag}] → map ({x:.2f}, {y:.2f}), ±{radius:.2f}m')

        ps = PoseStamped()
        ps.header.frame_id = self.map_frame
        ps.header.stamp = self.get_clock().now().to_msg()
        ps.pose.position.x = float(x)
        ps.pose.position.y = float(y)
        ps.pose.orientation.w = 1.0
        self.pub_confirmed.publish(ps)

        self._publish_markers()
        self._publish_list()
        self._publish_report()
        self._save_csv()
        self._enter_cooldown(self.get_clock().now())

    def _near_known(self, x, y):
        for v in self.victims:
            vx, vy = v[0], v[1]
            if (x - vx) ** 2 + (y - vy) ** 2 < self.merge_radius ** 2:
                return True
        return False

    # ==================================================================
    # 바닥 평면 투영: 픽셀 (u,v) -> map (x,y)
    # ==================================================================
    def _project_to_ground(self, u, v, w_px, h_px, stamp):
        """ 디버그판: (결과, 사유문자열) 반환.
            결과는 (x, y, dist, radius, method) 또는 None.
            method='ground'(바닥교차, 정확) / 'fallback'(bbox 동적추정, 추정구역) """
        fx, fy, cx, cy = self.K

        tf = None
        try:
            tf = self.tf_buffer.lookup_transform(
                self.map_frame, self.camera_frame,
                rclpy.time.Time.from_msg(stamp),
                timeout=rclpy.duration.Duration(seconds=0.1))
        except TransformException:
            try:
                tf = self.tf_buffer.lookup_transform(
                    self.map_frame, self.camera_frame, rclpy.time.Time())
            except TransformException as e2:
                return None, f'TF실패 {self.map_frame}<-{self.camera_frame} ({e2})'

        t = tf.transform.translation
        q = tf.transform.rotation
        O = np.array([t.x, t.y, t.z])
        R = self._quat_to_matrix(q.x, q.y, q.z, q.w)

        # --- 1순위: 발끝(bbox 하단) 시선의 바닥 교차 (가장 정확) ---
        d_foot = np.array([(u - cx) / fx, (v - cy) / fy, 1.0])
        D = R @ d_foot
        if D[2] < -1e-6:                      # 아래로 향함 → 바닥과 만남
            s = -O[2] / D[2]
            if s > 0:
                P = O + s * D
                dist = math.hypot(P[0] - O[0], P[1] - O[1])
                if dist <= self.max_range:
                    radius = self.uncert_base + self.uncert_slope * dist
                    return (float(P[0]), float(P[1]), dist, radius, 'ground'), 'ok'
                ground_reason = f'바닥교차 dist {dist:.1f}m > max_range({self.max_range})'
            else:
                ground_reason = f'교점이 카메라 뒤쪽 (s={s:.2f})'
        else:
            ground_reason = f'시선이 바닥과 안만남 (D_z={D[2]:.3f}>=0, 카메라 수평/위쪽; cam_z={O[2]:.2f})'

        # --- 2순위(폴백): bbox '최대 픽셀 길이'로 동적 거리추정 ---
        if not self.enable_fallback:
            return None, ground_reason
            
        # 가로, 세로 중 더 긴 값을 찾아 거리 추정에 사용
        if w_px is not None and h_px is not None and max(w_px, h_px) > 1.0:
            max_px = float(max(w_px, h_px))
            # 가로가 길면(누워있음) fx, 세로가 길면(서있음) fy 초점거리 사용
            f_effective = fx if w_px > h_px else fy
            
            # assumed_person_height (1.6m)를 가장 긴 픽셀 길이에 대응
            d_est = f_effective * self.assumed_person_height / max_px
            d_clamped = max(self.fallback_min_range, min(self.fallback_max_range, d_est))
            est_note = f'bbox동적추정(max_px={max_px:.1f}) d={d_est:.1f}→clamp {d_clamped:.1f}m'
        else:
            d_clamped = self.fallback_range
            est_note = f'bbox크기 비정상→기본 {d_clamped:.1f}m'

        # bbox 중심 시선을 수평면에 투영한 방향으로 d_clamped 만큼 이동
        d_ctr = np.array([(u - cx) / fx, 0.0, 1.0])   # 수직성분 제거 → 광축 수평면 방향
        Dc = R @ d_ctr
        norm = math.hypot(Dc[0], Dc[1])
        if norm < 1e-6:
            return None, ground_reason + ' / 폴백도 방향 불능(광축 수직)'
        px = O[0] + (Dc[0] / norm) * d_clamped
        py = O[1] + (Dc[1] / norm) * d_clamped
        return (float(px), float(py), d_clamped, self.fallback_uncert, 'fallback'), \
            f'폴백추정({est_note}, {ground_reason})'

    @staticmethod
    def _quat_to_matrix(x, y, z, w):
        n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
        x, y, z, w = x / n, y / n, z / n, w / n
        return np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w)],
            [2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y)],
        ])

    # ==================================================================
    # 출력: 마커 / 목록 / CSV
    # ==================================================================
    def _publish_markers(self):
        arr = MarkerArray()
        for i, v in enumerate(self.victims):
            x, y, rad = v[0], v[1], v[2]
            method = v[3] if len(v) > 3 else 'ground'
            # 정확(ground)=빨강 계열, 추정구역(fallback)=노랑/주황 계열로 구분
            if method == 'ground':
                disk_color = ColorRGBA(r=1.0, g=0.3, b=0.0, a=0.25)
                pin_color = ColorRGBA(r=1.0, g=0.0, b=0.0, a=0.9)
            else:
                disk_color = ColorRGBA(r=1.0, g=0.85, b=0.0, a=0.20)
                pin_color = ColorRGBA(r=1.0, g=0.7, b=0.0, a=0.9)

            disk = Marker()
            disk.header.frame_id = self.map_frame
            disk.header.stamp = self.get_clock().now().to_msg()
            disk.ns = 'victim_uncertainty'; disk.id = i
            disk.type = Marker.CYLINDER; disk.action = Marker.ADD
            disk.pose.position.x = x; disk.pose.position.y = y; disk.pose.position.z = 0.01
            disk.pose.orientation.w = 1.0
            disk.scale = Vector3(x=2 * rad, y=2 * rad, z=0.02)
            disk.color = disk_color
            arr.markers.append(disk)

            pin = Marker()
            pin.header = disk.header
            pin.ns = 'victim'; pin.id = i
            pin.type = Marker.SPHERE; pin.action = Marker.ADD
            pin.pose.position.x = x; pin.pose.position.y = y; pin.pose.position.z = 0.25
            pin.pose.orientation.w = 1.0
            pin.scale = Vector3(x=0.3, y=0.3, z=0.3)
            pin.color = pin_color
            arr.markers.append(pin)
        self.pub_markers.publish(arr)

    def _publish_list(self):
        pa = PoseArray()
        pa.header.frame_id = self.map_frame
        pa.header.stamp = self.get_clock().now().to_msg()
        for v in self.victims:
            p = Pose(); p.position = Point(x=v[0], y=v[1], z=0.0); p.orientation.w = 1.0
            pa.poses.append(p)
        self.pub_list.publish(pa)

    def _publish_report(self):
        """ 관제 서버용: 확정 victim 전체를 JSON 문자열로 발행(latched).
            서버는 rosbridge 로 받아 JSON.parse 만 하면 됨. """
        victims = []
        for i, v in enumerate(self.victims):
            x, y, rad = v[0], v[1], v[2]
            method = v[3] if len(v) > 3 else 'ground'
            victims.append({
                'id': i,
                'x': round(float(x), 3),
                'y': round(float(y), 3),
                'radius': round(float(rad), 3),
                'method': method,          # 'ground'(정확) / 'fallback'(추정)
            })
        payload = {
            'count': len(victims),
            'victims': victims,
            'stamp': self.get_clock().now().nanoseconds / 1e9,
        }
        msg = String()
        msg.data = json.dumps(payload, ensure_ascii=False)
        self.pub_report.publish(msg)

    def _save_csv(self):
        try:
            os.makedirs(os.path.dirname(self.csv_path), exist_ok=True)
            with open(self.csv_path, 'w', newline='') as f:
                wtr = csv.writer(f)
                wtr.writerow(['id', 'map_x', 'map_y', 'uncertainty_radius_m', 'method'])
                for i, v in enumerate(self.victims):
                    x, y, rad = v[0], v[1], v[2]
                    method = v[3] if len(v) > 3 else 'ground'
                    wtr.writerow([i, f'{x:.3f}', f'{y:.3f}', f'{rad:.3f}', method])
            self.get_logger().info(f'조난자 좌표 저장: {self.csv_path} ({len(self.victims)}명)')
        except Exception as e:
            self.get_logger().error(f'CSV 저장 실패: {e}')


def main(args=None):
    rclpy.init(args=args)
    node = VictimMapper()
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