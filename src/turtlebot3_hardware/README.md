# 하드웨어 구성 방법
## Raspberry Pi 4 Model B 핀맵
![raspberrypi_pinmap](https://mblogthumb-phinf.pstatic.net/MjAyNDAxMzBfMjI3/MDAxNzA2NTgyNjI2OTQy.rncH7idRr5UFwyzM3n8OoGjli_Xc6qy-TBNhvYiJs2wg.7KavH6uHHbgtQdsT1mf6GCBC-_VzMthy9XwID0HIFvQg.PNG.loyz/image.png?type=w966)

## OpenCR 1.0 핀맵
![opencr_pinmap](https://emanual.robotis.com/assets/images/parts/controller/opencr10/opencr_pinout.png)

## I2S 공통 배선
- SCK & BCLK    : RPI Pin 12 (GPIO 18)
- WS & LRC      : RPI Pin 35 (GPIO 19)

## I2S 모듈 배선
- 마이크 VDD    : 3.3V
- 마이크 L/R    : GND
- 마이크 GND    : GND
- 마이크 SD     : RPI Pin 38 (GPIO 20)
- 스피커 VIN    : 5V
- 스피커 GND    : GND
- 스피커 DIN    : RPI Pin 40 (GPIO 21)

## WS2812B 16구 링 LED 배선
- VCC   : 5V
- GND   : GND
- DIN   : RPI Pin 19 (GPIO 10)

## HAM4311 적외선 감지 센서 배선
- 공통 VCC  : 3.3V
- 공통 GND  : GND
- 센서1 OUT : RPI Pin 15 (GPIO 22)
- 센서2 OUT : RPI Pin 16 (GPIO 23)
- 센서3 OUT : RPI Pin 18 (GPIO 24)

# 사전 설정
## 펌웨어 컨픽 수정
```bash
sudo nano /boot/firmware/config.txt
```
파일 최하단에 아래 내용 추가
- `dtparam=spi=on`
- `dtparam=i2s=on`
- `dtoverlay=max98357a`
- `dtoverlay=googlevoicehat-soundcard`

## 하드웨어 그룹 권한 부여
```bash
sudo usermod -aG audio $USER
sudo usermod -aG video $USER
sudo usermod -aG plugdev $USER
sudo usermod -aG spi $USER
sudo usermod -aG dialout $USER
```

# 필요 패키지 설치
```bash
sudo apt update
sudo apt install python3-pyaudio mpg123 scons build-essential python3-rpi-lgpio alsa-utils flac
sudo pip3 install adafruit-circuitpython-neopixel-spi gTTS SpeechRecognition --break-system-packages
```

# 실행 방법
## 통합 런치 파일 실행
```bash
ros2 launch turtlebot3_hardware hardware_bringup.launch.py
```

# headlight_node 사용 방법
## 노드 실행
```bash
ros2 run turtlebot3_hardware headlight_node.py
```

## LED 켜기
```bash
ros2 topic pub -1 /headlight_cmd std_msgs/msg/String "{data: 'on'}"
```

## LED 끄기
```bash
ros2 topic pub -1 /headlight_cmd std_msgs/msg/String "{data: 'off'}"
```

## LED 깜빡이기
```bash
ros2 topic pub -1 /headlight_cmd std_msgs/msg/String "{data: 'blink'}"
```

# voice_node 사용 방법
## 노드 실행
```bash
ros2 run turtlebot3_hardware voice_node
```

## STT 수신하기
```bash
ros2 topic echo /recognized_text
```

## TTS로 말하기
```bash
ros2 topic pub -1 /speak_cmd std_msgs/msg/String "{data: 'hello'}"
```

## 주요 파라미터
- `led_brightness`
    - Integer
    - default=50   
    - LED 밝기를 0부터 100까지 값으로 제어 (100이 최대)
- `blink_period`
    - Float
    - default=0.5
    - `blink` 명령 수신 시 LED 점멸 주기 (초 단위)
- `blink_count`
    - Integer
    - default=3
    - `blink` 명령 수신 시 LED 점멸 횟수

# 트리비아
## 마이크 장치 테스트
마이크 장치 목록 조회
```
arecord -l
```

실시간 VU 미터 테스트
```bash
arecord -D plughw:1,0 -c 2 -r 48000 -f S32_LE -V stereo /dev/null
```

5초 녹음 테스트
```
arecord -D plughw:1,0 -c 2 -r 48000 -f S32_LE -d 5 test.wav
```

## 스피커 장치 테스트
스피커 장치 목록 조회
```bash
aplay -l
```

시스템 내장 스피커 테스트
```bash
speaker-test -D plughw:1,0 -c 2 -t wav
```

녹음 파일 재생 테스트
```bash
aplay -D plughw:1,0 test.wav
```