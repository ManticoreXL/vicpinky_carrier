# VicPinky Carrier
> 다중 로봇 협력형 재난 현장 구호활동 조력 로봇 시스템

## Demo
<!--데모 시나리오
1. 불꺼진 403호로 빅핑키 투입
2. 빅핑키 경사로 개방
3. 탐사용 터틀봇 플래시켜고 투입
4. 자율 탐사 시작 + 관제 화면도 같이
5. 요구조자 발견
6. TTS/STT로 의사소통
7. 빅핑키에서 OMX로 구호품 상차
8. 관제에서 요구조자 구호품 전달 명령
9. 요구조자에게 구호품 전달
10. 터틀봇 전부 빅핑키 앞으로 복귀
11. 라인트레이싱으로 회수 및 내부 주차
12. 빅핑키 경사로 폐쇄
13. 빅핑키 철수 -->
Coming Soon...


## Overview
VicPinky Carrier는 건물 붕괴 등 인력 투입이 어려운 협소 공간에 소형 로봇을 다수 투입하여 내부를 수색해 요구조자를 식별하고 구호품 전달이 가능한 구호 로봇 시스템입니다. 


## System Architecture
Coming Soon...


## Key Features
### Turtlebot
<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="assets/features/turtlebot/turtlebot_overview.jpg" width="100%"/><br/>
        <sub><b>터틀봇</b></sub>
      </td>
    </tr>
  </table>
</div>
협소 공간에 투입되어 요구조자를 탐색하거나 구호품을 전달할 수 있는 자율주행 로봇입니다. 수행 목적에 따라 탐사용과 구호용으로 구분되어 운용됩니다. 탐사용 터틀봇은 가장 먼저 현장에 투입되어 내부를 자율적으로 탐사하며, 요구조자를 식별하면 구호용 터틀봇이 관제 서버를 통해 그 위치로 이동하여 구호품을 전달합니다.

https://github.com/user-attachments/assets/6f7efe83-0220-42bc-89b3-1b40f406feb6

자율 탐사는 프론티어 기반 알고리즘으로 동작합니다. 프론티어가 가장 많은 방향을 우선적으로 이동하며, 미탐사 영역이 남지 않을 때까지 탐색을 반복하여 내부 전체를 지도화합니다.

<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_flash_off.jpg" width="100%"/><br/>
        <sub><b>전조등 OFF</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_flash_on.jpg" width="100%"/><br/>
        <sub><b>전조등 ON</b></sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_speaker.jpg" width="100%"/><br/>
        <sub><b>스피커</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_ir_sensor.jpg" width="100%"/><br/>
        <sub><b>IR 센서</b></sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_aruco_marker.jpg" width="100%"/><br/>
        <sub><b>상단 arUco 마커</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="assets/features/turtlebot/turtlebot_basket_loaded.jpg" width="100%"/><br/>
        <sub><b>구호품 적재 상태</b></sub>
      </td>
    </tr>
  </table>
</div>
터틀봇의 하드웨어는 재난 현장에 적합하게 카메라, 전조등, 마이크 및 스피커를 탑재한 사양으로 개조되었습니다. 전조등으로 저조도 환경에서도 시야를 확보하고, 마이크와 스피커를 통한 STT/TTS로 요구조자와 간단한 의사소통을 수행할 수 있도록 하였습니다.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="assets/features/turtlebot/yolo_model.webp" width="100%"/><br/>
        <sub><b>YOLO 요구조자 탐지</b></sub>
      </td>
    </tr>
  </table>
</div>
요구조자 인식은 카메라 영상을 입력으로 YOLO 모델을 로컬에서 구동해 추론하는 방식입니다. 요구조자가 화면에 인식되면 관제 서버로 보고하는 동시에, SLAM으로 생성한 지도 위에 AMCL로 추정한 위치를 표기하여 구호용 터틀봇이 참고하여 이동할 수 있게 합니다.

### VicPinky
<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img src="assets/features/vicpinky/vicpinky_ramp_closed.jpg" width="100%"/><br/>
        <sub><b>경사로 닫힘</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="assets/features/vicpinky/vicpinky_ramp_open.jpg" width="100%"/><br/>
        <sub><b>경사로 열림</b></sub>
      </td>
    </tr>
  </table>
</div>
터틀봇을 재난 현장으로 운송하는 중형 운반 플랫폼입니다. 현장에서는 거점 유지 역할을 수행하며, 경사로를 통해 터틀봇을 투입하거나 회수합니다. 내부에는 구호품을 적재할 수 있어 터틀봇을 통해 전달할 수 있습니다.

<div align="center">
  <table>
    <tr>
      <td align="center" width="33%">
        <img src="assets/features/vicpinky/vicpinky_driver_cam.jpg" width="100%"/><br/>
        <sub><b>전방 카메라</b></sub>
      </td>
      <td align="center" width="33%">
        <img src="assets/features/vicpinky/vicpinky_internal_cam.jpg" width="100%"/><br/>
        <sub><b>내부 카메라</b></sub>
      </td>
      <td align="center" width="33%">
        <img src="assets/features/vicpinky/vicpinky_omx_cam.jpg" width="100%"/><br/>
        <sub><b>OMX 카메라</b></sub>
      </td>
    </tr>
  </table>
</div>
카메라는 3대가 장착되어 전방 카메라는 주행에 사용하고, 내부 카메라는 터틀봇이 승차했을 때 차내 위치를 제어하는 주차 관제용으로 사용합니다. OMX 카메라는 매니퓰레이터의 추론을 위해 사용합니다.

<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img src="assets/features/vicpinky/vicpinky_ramp_action.webp" width="100%"/><br/>
        <sub><b>경사로 개폐</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="assets/features/vicpinky/vicpinky_line_trace.webp" width="100%"/><br/>
        <sub><b>라인트레이싱 회수</b></sub>
      </td>
    </tr>
  </table>
</div>
경사로는 장착된 DYNAMIXEL 모터 2개로 개폐하며, 경사로를 내려 터틀봇을 출입시킵니다. 터틀봇을 회수할 때는 경사로에 그어진 라인을 따라 라인트레이싱으로 올라오게 할 수 있습니다. 이렇게 진입한 터틀봇이 내부 카메라에 포착되면 주차 관제가 가능한 상태가 됩니다.

(내부 주차 Webm)
주차 관제는 OpenCV와 ArUco 마커 인식을 기반으로 터틀봇을 목표 지점까지 정밀 이동시키며, OMX 매니퓰레이터가 구호품을 상차하기 좋은 위치로 이동시킬 수도 있습니다.

### OMX Manipulator
<div align="center">
  <table>
    <tr>
      <td align="center" width="33%">
        <img src="assets/features/omx/omx_left.jpg" width="100%"/><br/>
        <sub><b>좌측면</b></sub>
      </td>
      <td align="center" width="33%">
        <img src="assets/features/omx/omx_back.jpg" width="100%"/><br/>
        <sub><b>후면</b></sub>
      </td>
      <td align="center" width="33%">
        <img src="assets/features/omx/omx_right.jpg" width="100%"/><br/>
        <sub><b>우측면</b></sub>
      </td>
    </tr>
  </table>
</div>
터틀봇의 바구니에 구호품 상차를 수행하는 매니퓰레이터입니다.빅핑키의 주차 관제를 통해 터틀봇을 상차 위치에 정렬하면 그 위치를 기준으로 동작합니다. 사람의 조종 없이 모방학습으로 학습한 동작을 추론해 상차를 수행합니다.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="assets/features/omx/omx_inference.webp" width="100%"/><br/>
        <sub><b>OMX 자율 상차 추론</b></sub>
      </td>
    </tr>
  </table>
</div>
추론은 비동기 분산 구조로 동작합니다. 빅핑키 내부에 추가로 설치된 라즈베리파이는 실시간 모터 제어와 카메라 처리를 담당하고, 무거운 추론 연산은 호스트 PC의 GPU로 분리해 네트워크로 통신하며 동작하도록 설계하였습니다. 전체 루프는 이벤트 기반으로 동작하여, 평소에는 대기하다가 관제로부터 추론 시작 명령을 받으면 해당 작업에 맞는 사전학습 모델을 불러와 동작합니다.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <img src="assets/features/omx/omx_dashboard.webp" width="100%"/><br/>
        <sub><b>OMX 추론 대시보드 화면</b></sub>
      </td>
    </tr>
  </table>
</div>

작업 완료 여부는 비전 인식으로 스스로 판단합니다. 상단부 카메라 영상을 HSV 색공간에서 분석해 구호품의 적재 여부와 중심 정렬 상태를 실시간으로 평가하며, 순간적인 조명 변화나 가려짐은 타이머 기반 필터링으로 걸러냅니다. 적재와 정렬 조건이 동시에 충족되면 목표 달성으로 판단해 추론 루프를 안전하게 종료하고 다시 대기 상태로 돌아갑니다.

### FMS Dashboard
(관제 대시보드 사진)
현장의 상황을 파악하고 로봇들의 상태를 모니터링 및 제어할 수 있는 통합 관제 시스템입니다. 관제를 넘어 실제로 다중 로봇을 운용하는 Fleet Management System 역할을 수행할 수 있습니다. 

(FMS 대시보드 사진)
수집된 맵을 노드-엣지 그래프로 관리하며, 관리자나 AI가 태스크를 생성하면 적합한 로봇에 배차해 최단경로로 자동 주행시킵니다. 태스크의 전 과정은 자동으로 처리되며, 경로상 노드 점유를 감지해 충돌을 방지하고, 장애가 발생한 노드는 폐쇄해 경유 중인 로봇을 우회시키며, 로봇 연결 끊김, 위치 추정 실패, 로봇 전복 등 상황도 스스로 감지해 태스크를 스케줄링합니다. 

(AI 기능 사진) (WebRTC 사진)
로봇과는 rosbridge, 프론트엔드와는 Socket.IO로 실시간 통신하여 토폴로지 맵, SLAM 지도, LiDAR, 카메라 영상을 한 화면에서 확인하고 로봇과 경사로를 직접 제어할 수 있습니다. 여기에 로컬 언어 모델 AI를 연동해, 자연어 명령을 태스크로 변환하고 현재 로봇들의 상황을 반영한 브리핑을 제공할 수 있습니다.


## How It Works
Coming Soon...


## Subsystems
Coming Soon...


## Quick Start Guide
Coming Soon...


## 팀원 소개 및 역할

| 프로필 | 이름 | 담당 역할 |
|:---:|:---:|---|
| <img src="https://github.com/Kor-JasonKim.png" width="100"/> | [김권](https://github.com/Kor-JasonKim) | <!-- TODO: 역할 --> |
| <img src="https://github.com/0307102bj41-afk.png" width="100"/> | [김동석](https://github.com/0307102bj41-afk) | <!-- TODO: 역할 --> |
| <img src="https://github.com/kdm111.png" width="100"/> | [박준수](https://github.com/kdm111) | <!-- TODO: 역할 --> |
| <img src="https://github.com/JH010918.png" width="100"/> | [명지훈](https://github.com/JH010918) | <!-- TODO: 역할 --> |
| <img src="https://github.com/miggh2.png" width="100"/> | [이경환](https://github.com/miggh2) | <!-- TODO: 역할 --> |
| <img src="https://github.com/ManticoreXL.png" width="100"/> | [최민석](https://github.com/ManticoreXL) | <!-- TODO: 역할 --> |
| <img src="https://github.com/chiya0123.png" width="100"/> | [최민지](https://github.com/chiya0123) | <!-- TODO: 역할 --> |


## LICENSE
Coming Soon...