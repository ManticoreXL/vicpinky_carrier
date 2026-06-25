#!/usr/bin/env python3
# =====================================================================
# victim_obstacle_publisher.py  (실시간 모드 / 데모 모드 공용)
#
# 역할:
#   확정된 victim(/victim/list, PoseArray) 위치를 nav2 costmap 에 장애물로
#   심기 위해, 각 victim 좌표 주변에 작은 원형 점군을 PointCloud2 로 주기 발행.
#   nav2 의 obstacle_layer(또는 voxel_layer)가 이 토픽(/victim/obstacles)을
#   observation_source 로 구독하면, planner 가 victim 을 피해 경로를 만든다.
#   (라이다에 안 걸리는 '누운 조난자'도 확실히 회피)
#
# 사용처:
#   - 실시간(auto_slam): mission_coordinator 와 함께 이 노드를 띄움.
#   - 데모(demo_localization): victim_inspector 와 함께 이 노드를 띄움.
#   * 회피 로직이 여기 한 곳에만 있으므로 양쪽 모드가 동일하게 동작.
#
# nav2_params 설정(필수): global/local costmap 의 obstacle_layer 에
#   observation_sources 에 victim_cloud 추가 + 아래처럼 토픽 연결.
#     victim_cloud:
#       topic: /victim/obstacles
#       data_type: "PointCloud2"
#       marking: true
#       clearing: false
#       min_obstacle_height: 0.0
#       max_obstacle_height: 0.5
#
# 토픽:
#   (구독) /victim/list       geometry_msgs/PoseArray  (확정 victim 전체, latched)
#   (발행) /victim/obstacles  sensor_msgs/PointCloud2  (costmap 회피용, 주기 발행)
# =====================================================================
import math
import struct

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy, QoSHistoryPolicy

from std_msgs.msg import Header
from geometry_msgs.msg import PoseArray
from sensor_msgs.msg import PointCloud2, PointField


class VictimObstaclePublisher(Node):
    def __init__(self):
        super().__init__('victim_obstacle_publisher')

        self.declare_parameter('victim_list_topic', '/victim/list')
        self.declare_parameter('obstacle_topic', '/victim/obstacles')
        self.declare_parameter('map_frame', 'map')
        self.declare_parameter('obstacle_radius', 1.0)   # victim 1명당 장애물 원 반경(m)
        self.declare_parameter('obstacle_points', 12)     # 원형으로 뿌릴 점 개수
        self.declare_parameter('obstacle_height', 0.10)   # 점 z 높이(costmap 높이 필터에 걸리게)
        self.declare_parameter('pub_rate', 2.0)           # 발행 주기(Hz)

        g = self.get_parameter
        self.map_frame = g('map_frame').value
        self.obstacle_topic = g('obstacle_topic').value
        self.obstacle_radius = float(g('obstacle_radius').value)
        self.obstacle_points = int(g('obstacle_points').value)
        self.obstacle_height = float(g('obstacle_height').value)
        self.pub_rate = float(g('pub_rate').value)

        self.victims = []   # [(x, y), ...]

        latched = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.RELIABLE,
                             durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                             history=QoSHistoryPolicy.KEEP_LAST)
        self.create_subscription(PoseArray, g('victim_list_topic').value,
                                 self._on_victim_list, latched)
        self.pub_obstacles = self.create_publisher(PointCloud2, self.obstacle_topic, latched)

        self.create_timer(1.0 / max(0.5, self.pub_rate), self._publish_obstacles)
        self.get_logger().info(
            f'victim_obstacle_publisher 시작. {g("victim_list_topic").value} → {self.obstacle_topic}')

    def _on_victim_list(self, msg: PoseArray):
        self.victims = [(p.position.x, p.position.y) for p in msg.poses]
        self.get_logger().info(f'victim 목록 갱신: {len(self.victims)}명 → 회피 장애물 반영.')

    def _publish_obstacles(self):
        pts = []
        for (x, y) in self.victims:
            for k in range(self.obstacle_points):
                ang = 2.0 * math.pi * k / self.obstacle_points
                px = x + self.obstacle_radius * math.cos(ang)
                py = y + self.obstacle_radius * math.sin(ang)
                pts.append((px, py, self.obstacle_height))
            pts.append((x, y, self.obstacle_height))   # 중심점
        self._publish_cloud(pts)

    def _publish_cloud(self, pts):
        msg = PointCloud2()
        msg.header = Header()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self.map_frame
        msg.height = 1
        msg.width = len(pts)
        msg.fields = [
            PointField(name='x', offset=0, datatype=PointField.FLOAT32, count=1),
            PointField(name='y', offset=4, datatype=PointField.FLOAT32, count=1),
            PointField(name='z', offset=8, datatype=PointField.FLOAT32, count=1),
        ]
        msg.is_bigendian = False
        msg.point_step = 12
        msg.row_step = msg.point_step * msg.width
        msg.is_dense = True
        buf = bytearray()
        for (x, y, z) in pts:
            buf += struct.pack('fff', x, y, z)
        msg.data = bytes(buf)
        self.pub_obstacles.publish(msg)


def main():
    rclpy.init()
    node = VictimObstaclePublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
