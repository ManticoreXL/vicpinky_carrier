#!/bin/bash
# OMX 다중 카메라 스트리머
# 사용법: ./start_omx.sh [카메라개수] [서버URL]

NUM_CAMERAS=${1:-2}
SERVER=${2:-"http://10.10.14.70:3001"}

echo "OMX 카메라 시작 ($NUM_CAMERAS개)"

for i in $(seq 0 $((NUM_CAMERAS-1))); do
    BOT_ID="omx_cam$i"
    DEVICE=$i

    python3 robot_webrtc.py \
        --bot-id "$BOT_ID" \
        --device "$DEVICE" \
        --server "$SERVER" \
        --width 320 --height 240 --fps 15 &

    echo "[$BOT_ID] 시작됨 (PID $!, device $DEVICE)"
    sleep 1
done

echo "모든 OMX 카메라 시작 완료. Ctrl+C로 종료"
wait
