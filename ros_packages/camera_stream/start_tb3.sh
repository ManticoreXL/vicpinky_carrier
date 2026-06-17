#!/bin/bash
# TB3 카메라 스트리머 (단일 카메라)
# 사용법: ./start_tb3.sh tb3_01 [서버URL]

BOT_ID=${1:-"tb3_01"}
SERVER=${2:-"http://10.10.14.70:3001"}

echo "TB3 카메라 시작: $BOT_ID"
python3 robot_webrtc.py \
    --bot-id "$BOT_ID" \
    --device 0 \
    --server "$SERVER" \
    --width 320 --height 240 --fps 15
