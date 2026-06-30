#!/bin/bash
# 서버(도메인 49) 맵 서버 실행 — 로봇별 nav2_map_server 로 정적 맵 발행.
# 도메인 브릿지가 /{robot}/map(49) → /map(로봇 도메인) 으로 latched 전달한다.

source /opt/ros/jazzy/setup.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ⚠ 유니캐스트 프로파일(fastdds_unicast.xml)은 쓰지 않는다.
# map_server↔lifecycle_manager 는 서버 로컬 노드라 기본 DDS(SHM/localhost) 로 서로를 찾아야 한다.
# (유니캐스트 peer 목록엔 로봇 IP만 있어 localhost 디스커버리가 막혀 활성화가 멈춤)
unset FASTRTPS_DEFAULT_PROFILES_FILE

# 서버 허브 도메인
export ROS_DOMAIN_ID=49

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  맵 서버(서버측, domain 49)"
echo "  tb3_03 → /tb3_03/map , tb3_04 → /tb3_04/map  (latched)"
echo "  도메인 브릿지가 /map 으로 각 로봇(43/44)에 주입"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ros2 launch "$SCRIPT_DIR/serve_maps.launch.py"
