#!/bin/bash

# Prevent running the entire script with sudo privileges
if [ "$EUID" -eq 0 ]; then
  echo "Error: Do not run this script directly with sudo privileges."
  echo "sudo will be automatically applied only to the necessary commands within the script."
  exit 1
fi

# Verify that both the Bot ID and IP address are provided as arguments
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./setup_env.sh [BOT_ID] [TURTLEBOT_IP]"
  echo "Example: ./setup_env.sh tb3_01 10.10.14.158"
  exit 1
fi

BOT_TARGET_ID=$1
ROBOT_IP=$2

echo "[1/6] Updating system packages and installing essential tools"
sudo apt-get update
sudo apt-get install -y make gcc unzip wget linux-headers-raspi v4l2loopback-dkms v4l2loopback-utils ffmpeg

echo "[2/6] Configuring v4l2loopback kernel module and installing ONNX Runtime"
sudo dpkg-reconfigure -f noninteractive v4l2loopback-dkms
echo "v4l2loopback" | sudo tee /etc/modules-load.d/v4l2loopback.conf
# 수정됨: 가상 장치 2개 할당에 맞추어 exclusive_caps=1,1 배열 적용
echo "options v4l2loopback devices=2 video_nr=2,3 exclusive_caps=1,1" | sudo tee /etc/modprobe.d/v4l2loopback.conf

sudo pip3 install onnxruntime --break-system-packages

echo "[3/6] Building and installing pigpio library from source"
cd ~
wget https://github.com/joan2937/pigpio/archive/master.zip
unzip -o master.zip
cd pigpio-master
make
sudo make install

echo "[4/6] Registering and starting pigpiod systemd daemon service"
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

sudo systemctl daemon-reload
sudo systemctl enable pigpiod --now

echo "[5/6] Registering and starting FFmpeg systemd daemon service"
sudo tee /etc/systemd/system/ffmpeg-stream.service << 'EOF'
[Unit]
Description=FFmpeg Video Stream Distributor
After=network.target

[Service]
ExecStart=/usr/bin/ffmpeg -f v4l2 -video_size 320x320 -framerate 15 -i /dev/video0 -f v4l2 /dev/video2 -f v4l2 /dev/video3
Restart=on-failure
RestartSec=5s
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ffmpeg-stream --now

echo "[6/6] Configuring ~/.bashrc environment variables (Bot ID and IP)"
# Insert only if the string does not exist in the file to prevent duplicates
if ! grep -q "GPIOZERO_PIN_FACTORY=pigpio" ~/.bashrc; then
    echo "export GPIOZERO_PIN_FACTORY=pigpio" >> ~/.bashrc
fi

# If there is an existing configuration, safely remove it and update with the newly entered value
sed -i '/export BOT_ID=/d' ~/.bashrc
echo "export BOT_ID=$BOT_TARGET_ID" >> ~/.bashrc

sed -i '/export PIGPIO_ADDR=/d' ~/.bashrc
echo "export PIGPIO_ADDR=$ROBOT_IP" >> ~/.bashrc

echo ""
echo "All environment configurations have been completed."

echo "To apply the changed environment variables to the current terminal, please run the command below:"
echo "source ~/.bashrc"