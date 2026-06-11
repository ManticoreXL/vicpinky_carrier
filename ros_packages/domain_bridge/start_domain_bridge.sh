#!/bin/bash
# domain_bridge 실행 스크립트
# 서버 PC에서 실행 (rosbridge와 같은 머신)
# ROS_DOMAIN_ID=40 으로 실행 — 브리지 자체는 여러 도메인에 동시 참여하므로 별도 설정 불필요

source /opt/ros/jazzy/setup.bash

# CycloneDDS 설정 (기존 dds_wifi.sh 와 동일하게)
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file://$HOME/cyclonedds.xml
# domain_bridge는 내부적으로 멀티도메인을 직접 처리하므로 ROS_DOMAIN_ID 고정 불필요

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/domain_bridge.yaml"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain Bridge 시작"
echo "  Config: $CONFIG"
echo "  tb3_01(41), tb3_02(42), tb3_03(43)"
echo "  tb3_04(44), omx(45) → 허브(40)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ros2 run domain_bridge domain_bridge --ros-args \
  -p config_file:="$CONFIG"
