#!/bin/bash
# domain_bridge 실행 스크립트 (LAN 환경)
# 각 로봇: 자기 domain에서 namespace 없이 발행
# domain 40: /tb3_01/*, /tb3_02/*, ... 형태로 수신

source /opt/ros/jazzy/setup.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain Bridge 시작"
echo "  tb3_01(41), tb3_02(42), tb3_03(43)"
echo "  tb3_04(44), omx(45) ↔ 허브(40)"
echo "  (각 파일에 uplink + downlink 통합)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ros2 run domain_bridge domain_bridge \
  "$SCRIPT_DIR/domain_bridge_tb3_01.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_02.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_03.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_04.yaml" \
  "$SCRIPT_DIR/domain_bridge_omx.yaml"
