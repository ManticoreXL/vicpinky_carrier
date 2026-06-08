# 하드웨어 구성 방법
## Raspberry Pi 4 Model B 핀맵
![raspberrypi_pinmap](https://mblogthumb-phinf.pstatic.net/MjAyNDAxMzBfMjI3/MDAxNzA2NTgyNjI2OTQy.rncH7idRr5UFwyzM3n8OoGjli_Xc6qy-TBNhvYiJs2wg.7KavH6uHHbgtQdsT1mf6GCBC-_VzMthy9XwID0HIFvQg.PNG.loyz/image.png?type=w966)
## OpenCR 1.0 핀맵
![opencr_pinmap](https://emanual.robotis.com/assets/images/parts/controller/opencr10/opencr_pinout.png)

## NeoPixel LED 모듈
- 5V    : 5V (RPI Pin 2)
- GND   : GND (RPI Pin 9)
- DI    : GPIO 12 (RPI Pin 32)

## I2S 공통 클럭
- 마이크 SCK, 스피커 BCLK   : GPIO 18 (RPI Pin 12)
- 마이크 WS, 스피커 LRC     : GPIO 19 (RPI Pin 35)
- 병렬 연결하려면 케이블 납땜 필요

## I2S 데이터 입출력
- 마이크 SD     : GPIO 20 (Pin 38)
- 스피커 DIN    : GPIO 21 (Pin 40)

## 전원 및 채널 설정
- 마이크 VDD    : 3.3V (Pin 1)
- 스피커 VIN    : 5V (OpenCR 5V)
- 마이크 L/R    : GND (Pin 14)
- GNDs (Pin 20, Pin 25, Pin 30, Pin 34, Pin 39)

# 사전 설정
```bash
sudo nano /boot/firmware/config.txt
```
파일 최하단에 아래 내용 추가
```Plaintext
dtparam=i2s=on
dtoverlay=max98357a
dtoverlay=googlevoicehat-soundcard
```

# 필요 패키지 정리
```bash
sudo apt-get install python-pyaudio mpg123 scons build-essentials
sudo pip3 install rpi_ws281x gTTS SpeechRecognition --break-system-packages
```

# 기타
- 하드웨어 패키지는 반드시 관리자 권한으로 실행해야 함