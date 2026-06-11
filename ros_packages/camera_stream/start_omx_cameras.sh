#!/bin/bash

# OMX 다중 카메라 스트리머 시작 스크립트
# 사용법: ./start_omx_cameras.sh [서버URL] [카메라개수]

SERVER=${1:-"http://10.10.14.70:3001"}
NUM_CAMERAS=${2:-2}

echo "OMX 카메라 시작 ($NUM_CAMERAS개)"

for i in $(seq 0 $((NUM_CAMERAS-1))); do
    BOT_ID="omx_cam$i"
    DEVICE=$i

    echo "[카메라 $i] 시작: $BOT_ID"
    python3 robot_webrtc.py \
        --bot-id "$BOT_ID" \
        --device "$DEVICE" \
        --server "$SERVER" \
        --width 320 --height 240 --fps 15 &

    sleep 1
done

echo "모든 카메라 시작 완료. Ctrl+C로 종료"
wait
