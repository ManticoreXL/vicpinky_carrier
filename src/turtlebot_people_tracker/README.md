# 사전 준비
## 필수 패키지 설치
```bash
sudo apt-get update
sudo apt-get install linux-headers-$(uname -r) v4l2loopback-dkms v4l2loopback-utils ffmpeg -y
sudo dkpg-reconfigure v4l2loopback-dkms
sudo pip3 install onnxruntime --break-system-packages
```

## 부팅 시 v4l2loopback 자동 적재 설정
```bash
echo "v4l2loopback" | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo "options v4l2loopback devices=2 video_nr=2,3 exclusive_caps=1" | sudo tee /etc/modprobe.d/v4l2loopback.conf
```
- 2번, 3번 카메라를 

# 실행 방법
## v4l2loopback 모듈 적재
```bash
sudo modprobe v4l2loopback devices=2 video_nr=2,3 exclusive_caps=1
```
- 자동 적재를 설정했다면 직접 실행할 필요 없음

## FFmpeg 카메라 스트림 분배
```bash
nohup ffmpeg -f v4l2 -video_size 320x320 -framerate 15 -i /dev/video0 -f v4l2 /dev/video2 -f v4l2 /dev/video3 > /dev/null 2>&1 &
```
- launch 파일에서 FFmpeg를 실행한다면 직접 실행할 필요 없음

## 노드 실행
```bash
ros2 run turtlebot_people_tracker people_detector --ros-args -p bot_id:=tb3_01 device:=2
```
- bot_id는 터틀봇 ID에 맞게 수정해서 실행
- device는 카메라 장치 번호로 가상 카메라인 2번 사용 권장