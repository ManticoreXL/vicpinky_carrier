# OMX 
로봇 매니퓰레이터의 자율 동작을 위한 비동기 모방학습 추론 시스템

## 시스템 아키텍처

```text
=============================================================================
                🤖 OMX Robot Control & Inference System
=============================================================================

[ 🖥️ 로봇 클라이언트 (Robot Client) ]
 │
 ├── 1. Vision & Background Threading
 │   ├── 📷 Front Cam (IDX:5) ──▶ [ HSV 컬러 감지 & ROI 판정 ] ──┐
 │   │                                                           │
 │   └── 📷 Wrist Cam (IDX:6) ──▶ [ 단순 프레임 읽기 ] ──────────┤
 │                                                               ▼
 │                                                     [ 🗂️ Frame Buffer ]
 │                                                     (최신 프레임 메모리)
 │                                                               │
 ├── 2. Web Monitor (독립 프로세스)                               │
 │   └── 🌐 Flask Web Server ◀─────────────────────────────────┤
 │       └── 브라우저 접속 (Port 5000)                            │
 │                                                               │
 ├── 3. ROS 2 Control (OmxStateNode)                             │
 │   ├── 📥 Sub: /vision/start_inference (추론 시작 명령 대기)    │
 │   ├── 📤 Pub: /vision/is_loaded       (안착 상태 발행)        │
 │   ├── 📤 Pub: /vision/object_red/blue (객체 감지 발행)        │
 │   └── 🎯 조건 충족 시 추론 시작 Event 발동                     │
 │                                                               │
 └── 4. LeRobot Inference (모방학습 루프)                         │
     ├── 📸 HookedVideoCapture ◀───────────────────────────────┘
     │   (cv2.VideoCapture 함수를 가로채어 지연 없이 프레임 공급)
     └── ⚙️ runpy 모듈 실행 (robot_client)
             │
             ▼ (통신: 📷 이미지 전송 및 🦾 Action 수신)
             ▼ Server IP: 10.10.14.63:5432

-----------------------------------------------------------------------------

[ ☁️ 원격 추론 서버 (Policy Server) ]
 │
 └── 🧠 LeRobot Policy Server ──▶ [ ACT Policy (PyTorch) ] ──▶ 🦾 로봇 모터 제어

=============================================================================
```
