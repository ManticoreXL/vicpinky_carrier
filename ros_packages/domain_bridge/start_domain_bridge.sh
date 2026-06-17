#!/bin/bash
# domain_bridge 실행 스크립트
# 서버 PC에서 실행 (rosbridge와 같은 머신)

source /opt/ros/jazzy/setup.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain Bridge 시작"
echo "  tb3_01(41), tb3_02(42), tb3_03(43)"
echo "  tb3_04(44), omx(45) → 허브(40)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ros2 run domain_bridge domain_bridge \
  "$SCRIPT_DIR/domain_bridge.yaml" \
  "$SCRIPT_DIR/tf_bridge_tb3_01.yaml" \
  "$SCRIPT_DIR/tf_bridge_tb3_02.yaml" \
  "$SCRIPT_DIR/tf_bridge_tb3_03.yaml" \
  "$SCRIPT_DIR/tf_bridge_tb3_04.yaml" \
  "$SCRIPT_DIR/tf_bridge_omx.yaml"
