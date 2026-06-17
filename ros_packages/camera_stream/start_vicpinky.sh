#!/bin/bash
# VICPINKY 다중 카메라 스트리머
# 사용법: ./start_vicpinky.sh [서버URL]

SERVER=${1:-"http://10.10.14.70:3001"}

echo "VICPINKY 카메라 시작 (2개)"

# 카메라 0
python3 robot_webrtc.py \
    --bot-id vicpinky_cam0 \
    --device 0 \
    --server "$SERVER" \
    --width 320 --height 240 --fps 15 &

echo "[vicpinky_cam0] 시작됨 (PID $!)"

sleep 1

# 카메라 1
python3 robot_webrtc.py \
    --bot-id vicpinky_cam1 \
    --device 1 \
    --server "$SERVER" \
    --width 320 --height 240 --fps 15 &

echo "[vicpinky_cam1] 시작됨 (PID $!)"

echo "모든 VICPINKY 카메라 시작 완료. Ctrl+C로 종료"
wait
