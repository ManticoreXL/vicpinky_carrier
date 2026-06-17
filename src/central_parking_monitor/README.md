# 사전 준비 사항
## pigpio 라이브러리 설치 및 데몬 설정
```bash
sudo apt update && sudo apt install -y make gcc unzip wget
cd ~
wget [https://github.com/joan2937/pigpio/archive/master.zip](https://github.com/joan2937/pigpio/archive/master.zip)
unzip master.zip
cd pigpio-master
make
sudo make install
```

## systemd 서비스 등록
```bash
sudo tee /etc/systemd/system/pigpiod.service << 'EOF'
[Unit]
Description=Pigpio daemon for Remote GPIO
After=network.target

[Service]
ExecStart=/usr/local/bin/pigpiod
Type=forking
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
```

## daemon 실행 및 상태 확인
```bash
sudo systemctl daemon-reload
sudo systemctl enable pigpiod --now
sudo systemctl status pigpiod
```

## 환경 변수 설정
```bash
nano ~/.bashrc
```
아래 내용 추가
```PlainText
export GPIOZERO_PIN_FACTORY=pigpio
export PIGPIO_ADDR=<터틀봇IP>
```

이후 적용하기
```bash
source ~/.bashrc
```

# 실행 방법
## 라인트레이싱 노드 실행
```bash
ros2 run central_parking_monitor reverse_line_follower --ros-args -p bot_id:=tb3_01
```
- bot_id는 터틀봇 ID에 맞게 수정해서 실행

## 라인트레이싱 시작 신호 발행
```bash
ros2 topic pub --once /robot_mode std_msgs/msg/String "{data: 'LINE_TRACE'}"
```

## 라인트레이싱 중지 신호 발행
```bash
ros2 topic pub --once /robot_mode std_msgs/msg/String "{data: 'PARKING'}"
```