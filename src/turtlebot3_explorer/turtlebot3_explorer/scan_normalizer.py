#!/usr/bin/env python3
# scan_normalizer.py
# LDS-02 라이다가 한 바퀴마다 포인트 수가 달라져(예: 225~227) slam_toolbox가
# 스캔을 조용히 드롭하는 문제 해결용.
# /scan 을 받아서 고정 각도 격자(고정 개수)로 리샘플 후 /scan_normalized 로 발행.
import math
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan


class ScanNormalizer(Node):
    def __init__(self):
        super().__init__('scan_normalizer')
        self.declare_parameter('input_topic', '/scan')
        self.declare_parameter('output_topic', '/scan_normalized')
        # 고정 출력 빔 개수. 0 이면 첫 스캔의 개수로 자동 고정.
        self.declare_parameter('num_beams', 0)

        self.in_topic = self.get_parameter('input_topic').value
        self.out_topic = self.get_parameter('output_topic').value
        self.num_beams = int(self.get_parameter('num_beams').value)

        # 고정 격자(첫 스캔 or 파라미터 기준). 한 번 잠그면 계속 유지.
        self._locked = False
        self._angle_min = None
        self._angle_max = None
        self._angle_inc = None
        self._grid_angles = None

        self.sub = self.create_subscription(
            LaserScan, self.in_topic, self._cb, qos_profile_sensor_data)
        self.pub = self.create_publisher(
            LaserScan, self.out_topic, qos_profile_sensor_data)
        self.get_logger().info(
            f'scan_normalizer 시작: {self.in_topic} -> {self.out_topic}')

    def _lock_grid(self, msg):
        self._angle_min = msg.angle_min
        self._angle_max = msg.angle_max
        n = self.num_beams if self.num_beams > 0 else len(msg.ranges)
        if n < 2:
            n = len(msg.ranges)
        self._angle_inc = (self._angle_max - self._angle_min) / (n - 1)
        self._grid_angles = [self._angle_min + i * self._angle_inc
                             for i in range(n)]
        self._locked = True
        self.get_logger().info(
            f'격자 고정: {n} beams, angle_min={self._angle_min:.4f}, '
            f'angle_max={self._angle_max:.4f}, inc={self._angle_inc:.6f}')

    def _cb(self, msg):
        if not self._locked:
            self._lock_grid(msg)

        n_out = len(self._grid_angles)
        src_n = len(msg.ranges)
        out_ranges = [float('inf')] * n_out
        out_intens = [0.0] * n_out
        has_int = len(msg.intensities) == src_n

        # 입력 각도 → 출력 격자의 가장 가까운 칸으로 매핑(nearest)
        for j in range(src_n):
            a = msg.angle_min + j * msg.angle_increment
            idx = int(round((a - self._angle_min) / self._angle_inc))
            if 0 <= idx < n_out:
                r = msg.ranges[j]
                # 더 가까운 유효값 우선
                if math.isfinite(r) and r < out_ranges[idx]:
                    out_ranges[idx] = r
                    if has_int:
                        out_intens[idx] = msg.intensities[j]

        out = LaserScan()
        out.header = msg.header            # stamp/frame_id 그대로 유지(중요)
        out.angle_min = self._angle_min
        out.angle_max = self._angle_max
        out.angle_increment = self._angle_inc
        out.time_increment = msg.time_increment
        out.scan_time = msg.scan_time
        out.range_min = msg.range_min
        out.range_max = msg.range_max
        out.ranges = out_ranges
        out.intensities = out_intens
        self.pub.publish(out)


def main():
    rclpy.init()
    node = ScanNormalizer()
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
