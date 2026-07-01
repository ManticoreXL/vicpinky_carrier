#!/bin/bash
# domain_bridge 실행 스크립트 (LAN 환경)
# 각 로봇: 자기 domain에서 namespace 없이 발행
# 허브(49)에서 /tb3_01/*, /tb3_02/*, ... 형태로 수신

source /opt/ros/jazzy/setup.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 커스텀 메시지/액션/서비스 타입을 domain_bridge 가 인식하려면 해당 워크스페이스 install 을
# 모두 source 해야 한다. 하나라도 빠지면 그 타입을 쓰는 bridge 가 로드 시 프로세스를 죽일 수 있다.
#   - 최상위 install : vicpinky_carrier_interfaces(RampState/RampControl) 등
#   - rosbridge/install : turtlebot_state_msgs(LineTrace/Deploy) 등  ← tb3 line_trace/deploy 서비스에 필요
for WS_SETUP in \
  "$SCRIPT_DIR/../../install/setup.bash" \
  "$SCRIPT_DIR/../../rosbridge/install/setup.bash"; do
  if [ -f "$WS_SETUP" ]; then
    source "$WS_SETUP"
    echo "  워크스페이스 install source: $WS_SETUP"
  else
    echo "  ⚠ install 없음: $WS_SETUP — 일부 커스텀 타입이 안 잡힐 수 있음"
  fi
done

DDS_CONFIG="$SCRIPT_DIR/../dds_config/fastdds_unicast.xml"

if [ -f "$DDS_CONFIG" ]; then
  export FASTRTPS_DEFAULT_PROFILES_FILE="$DDS_CONFIG"
  echo "  FastDDS 유니캐스트 설정 로드: $DDS_CONFIG"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain Bridge 시작"
echo "  vicpinky(40), tb3_01(41), tb3_02(42)"
echo "  tb3_03(43), tb3_04(44), omx(45) ↔ 서버(49)"
echo "  (각 파일에 uplink + downlink 통합)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 액션 릴레이 ──
# domain_bridge 는 액션(actions:)을 중계하지 못한다(0.5.0 미지원). /ramp_control 등 액션은
# action_relay.py 가 허브(49)↔로봇(40)로 대신 중계한다. 위에서 source·FASTRTPS 를 그대로 상속한다.
python3 "$SCRIPT_DIR/action_relay.py" &
RELAY_PID=$!
echo "  액션 릴레이 시작 (PID $RELAY_PID) — /ramp_control 49↔40"
# domain_bridge 종료(Ctrl+C) 시 릴레이도 함께 정리
trap 'kill "$RELAY_PID" 2>/dev/null' EXIT INT TERM

ros2 run domain_bridge domain_bridge \
  "$SCRIPT_DIR/domain_bridge_vicpinky.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_01.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_02.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_03.yaml" \
  "$SCRIPT_DIR/domain_bridge_tb3_04.yaml" \
  "$SCRIPT_DIR/domain_bridge_omx.yaml"
