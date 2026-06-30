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
        self.declare_parameter('victim_report_topic', '/victim/report')  # victim별 불확실성 radius 포함(JSON)
        self.declare_parameter('obstacle_topic', '/victim/obstacles')
        self.declare_parameter('map_frame', 'map')
        self.declare_parameter('obstacle_radius', 0.5)   # victim별 radius 없을 때 쓰는 기본 반경(m)
        self.declare_parameter('safety_margin', 0.3)     # victim 반경에 더하는 안전 여유(m). 밟기 방지.
        self.declare_parameter('use_victim_radius', True)  # True면 각 victim 불확실성 radius 사용(+여유)
        self.declare_parameter('fill_disc', True)         # True면 원 안쪽까지 채움(빈 원이면 안쪽 통과 위험)
        self.declare_parameter('ring_step', 0.25)         # 채울 때 반경 방향 점 간격(m)
        self.declare_parameter('obstacle_points', 12)     # 원주 방향 점 개수
        self.declare_parameter('obstacle_height', 0.10)   # 점 z 높이(costmap 높이 필터에 걸리게)
        self.declare_parameter('pub_rate', 2.0)           # 발행 주기(Hz)

        g = self.get_parameter
        self.map_frame = g('map_frame').value
        self.obstacle_topic = g('obstacle_topic').value
        self.obstacle_radius = float(g('obstacle_radius').value)
        self.safety_margin = float(g('safety_margin').value)
        self.use_victim_radius = bool(g('use_victim_radius').value)
        self.fill_disc = bool(g('fill_disc').value)
        self.ring_step = float(g('ring_step').value)
        self.obstacle_points = int(g('obstacle_points').value)
        self.obstacle_height = float(g('obstacle_height').value)
        self.pub_rate = float(g('pub_rate').value)

        self.victims = []   # [(x, y, radius), ...]  radius=불확실성(없으면 obstacle_radius)
        self._radii = {}    # report 로 받은 victim별 radius (인덱스 → radius)

        latched = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.RELIABLE,
                             durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                             history=QoSHistoryPolicy.KEEP_LAST)
        self.create_subscription(PoseArray, g('victim_list_topic').value,
                                 self._on_victim_list, latched)
        # victim별 불확실성 radius 를 얻기 위해 report(JSON) 도 구독(있으면 사용)
        if self.use_victim_radius:
            from std_msgs.msg import String
            self.create_subscription(String, g('victim_report_topic').value,
                                     self._on_victim_report, latched)
        self.pub_obstacles = self.create_publisher(PointCloud2, self.obstacle_topic, latched)

        self.create_timer(1.0 / max(0.5, self.pub_rate), self._publish_obstacles)
        self.get_logger().info(
            f'victim_obstacle_publisher 시작. {g("victim_list_topic").value} → {self.obstacle_topic}')

    def _on_victim_report(self, msg):
        """ /victim/report(JSON)에서 victim별 불확실성 radius 추출.
            형식: {"victims":[{"x":..,"y":..,"radius":..}, ...]} """
        import json
        try:
            data = json.loads(msg.data)
            self._radii = {}
            for i, v in enumerate(data.get('victims', [])):
                r = v.get('radius', None)
                if r is not None:
                    # (x,y)로 매칭(인덱스보다 좌표가 안전)
                    self._radii[(round(float(v['x']), 2), round(float(v['y']), 2))] = float(r)
        except Exception as e:
            self.get_logger().warn(f'victim report 파싱 실패: {e}')

    def _on_victim_list(self, msg: PoseArray):
        victims = []
        for p in msg.poses:
            x, y = p.position.x, p.position.y
            # report 에서 받은 불확실성 radius 있으면 사용, 없으면 기본값
            r = self._radii.get((round(x, 2), round(y, 2)), self.obstacle_radius)
            victims.append((x, y, r))
        self.victims = victims
        self.get_logger().info(f'victim 목록 갱신: {len(self.victims)}명 → 회피 장애물 반영.')

    def _publish_obstacles(self):
        pts = []
        for (x, y, r_uncert) in self.victims:
            # 실제 회피 반경 = victim 불확실성 + 안전여유 (밟기 방지 핵심)
            if self.use_victim_radius:
                radius = r_uncert + self.safety_margin
            else:
                radius = self.obstacle_radius + self.safety_margin

            if self.fill_disc:
                # 원 안쪽까지 채움: 중심→반경까지 여러 동심원
                n_rings = max(1, int(math.ceil(radius / max(0.05, self.ring_step))))
                for ri in range(n_rings + 1):
                    rr = radius * ri / n_rings
                    if rr < 1e-3:
                        pts.append((x, y, self.obstacle_height))   # 중심
                        continue
                    # 반경에 비례해 점 개수 늘림(촘촘하게)
                    n_ang = max(self.obstacle_points,
                                int(self.obstacle_points * rr / max(0.1, self.ring_step)))
                    for k in range(n_ang):
                        ang = 2.0 * math.pi * k / n_ang
                        pts.append((x + rr * math.cos(ang),
                                    y + rr * math.sin(ang),
                                    self.obstacle_height))
            else:
                # 테두리만(기존 방식)
                for k in range(self.obstacle_points):
                    ang = 2.0 * math.pi * k / self.obstacle_points
                    pts.append((x + radius * math.cos(ang),
                                y + radius * math.sin(ang),
                                self.obstacle_height))
                pts.append((x, y, self.obstacle_height))
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
