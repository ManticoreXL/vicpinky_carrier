#!/bin/bash
# 각 로봇에서 source 해서 쓸 환경 설정
# 사용: source robot_env.sh tb3_01
# (로봇 bringup 전에 이 파일을 source 하면 도메인이 자동 설정)

ROBOT_ID="${1:-}"

case "$ROBOT_ID" in
  vicpinky) export ROS_DOMAIN_ID=40 ;;
  tb3_01)   export ROS_DOMAIN_ID=41 ;;
  tb3_02)   export ROS_DOMAIN_ID=42 ;;
  tb3_03)   export ROS_DOMAIN_ID=43 ;;
  tb3_04)   export ROS_DOMAIN_ID=44 ;;
  omx)      export ROS_DOMAIN_ID=45 ;;
  *)
    echo "사용법: source robot_env.sh <robot_id>"
    echo "  robot_id: vicpinky tb3_01 tb3_02 tb3_03 tb3_04 omx"
    return 1
    ;;
esac

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI=file://$HOME/cyclonedds.xml

echo "✓ 도메인 설정: $ROBOT_ID → ROS_DOMAIN_ID=$ROS_DOMAIN_ID"
