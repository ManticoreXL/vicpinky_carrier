#!/bin/bash
# domain_bridge 실행 스크립트 (LAN 환경)
# 각 로봇: 자기 domain에서 namespace 없이 발행
# domain 40: /tb3_01/*, /tb3_02/*, ... 형태로 수신

source /opt/ros/jazzy/setup.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 워크스페이스 install source — vicpinky_carrier_interfaces(RampState/RampControl) 등
# 커스텀 메시지/액션 타입을 domain_bridge가 인식하려면 필요.
WS_SETUP="$SCRIPT_DIR/../../install/setup.bash"
if [ -f "$WS_SETUP" ]; then
  source "$WS_SETUP"
  echo "  워크스페이스 install source: $WS_SETUP"
else
  echo "  ⚠ 워크스페이스 install 없음 — vicpinky 커스텀 타입(ramp 등)이 안 잡힐 수 있음"
fi

DDS_CONFIG="$SCRIPT_DIR/../dds_config/fastdds_unicast.xml"

if [ -f "$DDS_CONFIG" ]; then
  export FASTRTPS_DEFAULT_PROFILES_FILE="$DDS_CONFIG"
  echo "  FastDDS 유니캐스트 설정 로드: $DDS_CONFIG"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain Bridge 시작"
echo "  vicpinky(40), tb3_01(41), tb3_02(42)"
echo "  tb3_03(43), tb3_04(44), omx(45) pinky_02(47) ↔ 서버(49)"
echo "  (각 파일에 uplink + downlink 통합)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ros2 run domain_bridge domain_bridge \
  "$SCRIPT_DIR/domain_bridge_vicpinky.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_01.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_02.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_03.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_04.yaml" \
  "$SCRIPT_DIR/domain_bridge_omx.yaml" \
  "$SCRIPT_DIR/domain_bridge_pinky_02.yaml"
