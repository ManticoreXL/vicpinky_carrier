# SETUP — Windows / macOS / Linux 실행 가이드

## 0. 아키텍처와 OS 호환성 (먼저 읽기)

이 프로젝트는 **웹 대시보드**와 **ROS2 로봇 레이어**로 나뉩니다. 둘의 OS 지원이 다릅니다.

| 레이어 | Windows | macOS | Linux | 비고 |
|---|:---:|:---:|:---:|---|
| 웹 프론트 (`web_front`, React) | ✅ | ✅ | ✅ | Node, 어디서나 네이티브 |
| 웹 백엔드 (`web_back`, NestJS) | ✅ | ✅ | ✅ | Node, 네이티브. STT만 `python3` 필요(선택) |
| MongoDB | ✅ | ✅ | ✅ | 네이티브 설치본 제공 |
| Ollama (LLM) | ✅ | ✅ | ✅ | 네이티브 설치본 제공 |
| **ROS2 Jazzy + rosbridge + 로봇 패키지** | ⚠️ WSL2 | ⚠️ Docker | ✅ 네이티브 | **Ubuntu 24.04 전용** |

> **핵심:** 웹 대시보드(프론트+백엔드+Mongo+Ollama)는 **어느 OS에서도 네이티브로** 돌아갑니다.
> ROS2 레이어만 리눅스(Ubuntu 24.04) 전용이라, Windows는 **WSL2**, macOS는 **Docker/VM**으로 띄웁니다.
> 로봇/ROS 없이 대시보드만 실행해도 화면은 뜹니다(라이브 로봇 데이터만 안 들어옴).

---

## 1. 공통 사전 준비 (모든 OS)

대시보드를 띄우려면 **Node 20 · MongoDB · Ollama** 가 필요합니다. 설치 방법은 §2(OS별)에 있습니다. 공통으로 해야 할 일:

1. **MongoDB 계정 생성** — `.env`의 `MONGO_URI` 와 일치해야 함 (`fms_admin` / `fms_password` / DB `fms_db`)
   ```js
   // mongosh 에서
   use admin
   db.createUser({
     user: "fms_admin", pwd: "fms_password",
     roles: [{ role: "readWrite", db: "fms_db" }, { role: "dbAdmin", db: "fms_db" }]
   })
   ```
2. **Ollama 모델 3개 받기** (총 ~14GB)
   ```bash
   ollama pull qwen2.5:7b        # 도구 호출 / 명령
   ollama pull exaone3.5:latest  # 답변 / 브리핑
   ollama pull llava             # 비전 분석
   ```
3. **`web_back/.env` 생성** — git에 없음. §5 내용을 그대로 복사 후 OS에 맞게 `MAPS_DIR` 만 수정
4. **맵 폴더 준비** — `MAPS_DIR` 경로에 `*.pgm` / `*.yaml` 맵 파일 복사 (예: `401`, `project_slam_map`)
5. **(선택) 가상 테스트봇 `TEST-BOT` 등록** — §7 참고. ROS/rosbridge 없이 대시보드만으로 태스크 흐름을 테스트할 때 사용. 백엔드가 자동 등록하지만, 미리 DB에 넣어두려면 §7의 mongosh 명령을 실행

---

## 2. OS별 설치

### 🐧 Linux (Ubuntu 24.04) — 권장(전체 기능)
```bash
# Node 20 (nvm 권장)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

# MongoDB Community + mongosh : 공식 apt 저장소 사용
#   https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/
sudo systemctl start mongod

# Ollama
curl -fsSL https://ollama.com/install.sh | sh

# (선택) STT: 음성 명령 기능용
pip install faster-whisper        # python3 가 PATH에 있어야 함
```
`.env`: `MAPS_DIR=/home/<사용자>/map` (기본값은 `/home/js/map`)

### 🪟 Windows 10/11
대시보드는 **Windows 네이티브**로, ROS2는 **WSL2**로 돌립니다.
```powershell
# Node 20
winget install OpenJS.NodeJS.LTS

# MongoDB (서버 + mongosh)
winget install MongoDB.Server
winget install MongoDB.Shell

# Ollama
winget install Ollama.Ollama

# (선택) STT: Python + faster-whisper
winget install Python.Python.3.12
pip install faster-whisper
```
- `.env`: `MAPS_DIR=C:/Users/<사용자>/map` — **슬래시(`/`) 사용 권장** (Node가 Windows에서도 처리)
- STT 주의: 코드가 `python3` 명령을 호출합니다. Windows는 보통 `python` 이므로, STT를 쓰려면 `python3` 별칭을 만들거나 STT 기능은 건너뜁니다(다른 기능은 정상).
- ROS2는 §4의 WSL2 안내 참고.

### 🍎 macOS (Homebrew)
대시보드는 **macOS 네이티브**, ROS2는 **Docker**로 돌립니다.
```bash
brew install node@20
brew tap mongodb/brew && brew install mongodb-community
brew services start mongodb-community
brew install ollama && ollama serve   # 또는 Ollama.app 실행

# (선택) STT
pip3 install faster-whisper            # python3 는 macOS 기본 제공
```
- `.env`: `MAPS_DIR=/Users/<사용자>/map`
- ROS2는 §4의 Docker 안내 참고.

---

## 3. 웹 스택 실행 (모든 OS 공통 명령)

```bash
# 백엔드 (:3001) — MongoDB·Ollama 가 먼저 떠 있어야 함
cd web_back
npm install
npm run start          # 개발 모드: npm run start:dev

# 프론트 (:3000) — 새 터미널
cd web_front
npm install
npm start
```
브라우저에서 `http://localhost:3000` 접속.
프론트는 접속 호스트 기준으로 백엔드/rosbridge 주소를 자동 결정하므로(`http://<host>:3001`, `ws://<host>:9090`) 코드 수정이 필요 없습니다.

---

## 4. ROS2 레이어 (로봇 / SLAM / rosbridge)

ROS2 **Jazzy + Ubuntu 24.04** 전용입니다. 대시보드는 `ROSBRIDGE_URL`(기본 `:9090`)로 rosbridge에 붙습니다.

### Linux 네이티브
```bash
source /opt/ros/jazzy/setup.bash
cd <repo>
vcs import src < vicpinky.repos
vcs import src < turtlebot.repos
pip install -r requirements.txt
rosdep update && rosdep install --from-paths src --ignore-src -y --rosdistro jazzy
colcon build --base-path src
source install/setup.bash
# rosbridge (ws:9090)
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
```

### Windows → WSL2
```powershell
wsl --install -d Ubuntu-24.04
```
WSL2 Ubuntu 24.04 안에서 **위 "Linux 네이티브" 절차 그대로** 수행하고 rosbridge를 띄웁니다.
- WSL2의 rosbridge는 보통 `ws://localhost:9090` 으로 Windows 호스트에서 접근됩니다(WSL2 localhost 포워딩). 안 되면 WSL2 IP(`wsl hostname -I`)를 `.env`/접속에 사용.

### macOS → Docker
Apple Silicon에서는 `--platform linux/amd64` 로 ROS2 Jazzy 컨테이너를 실행합니다.
```bash
docker run -it --platform linux/amd64 -p 9090:9090 ros:jazzy bash
# 컨테이너 안에서: rosbridge_suite 설치 후 위 Linux 절차 수행
```
포트 `9090` 을 호스트로 노출하면 macOS의 대시보드가 `ws://localhost:9090` 으로 접속.

---

## 5. `web_back/.env` 전체 내용

> git에 포함되지 않으므로 아래 내용을 `web_back/.env` 로 새로 생성하세요.
> **OS별로 `MAPS_DIR` 만 맞춰주면 되고**, `ROSBRIDGE_URL`·`MONGO_URI`·`OLLAMA_URL` 은 환경에 맞게 수정합니다.
> `ROS2_SETUP`·`ROS2_WS_SETUP`·`CARTOGRAPHER_*`·`ROS_DOMAIN_ID`·`OLLAMA_KEEP_ALIVE` 는 **현재 코드가 읽지 않는 레거시 값**이라 그대로 둬도/지워도 무방합니다.

```dotenv
# rosbridge 주소 — ROS2가 도는 곳. 로컬이면 ws://localhost:9090
ROSBRIDGE_URL=ws://10.10.14.70:9090

# MongoDB 연결 (§1에서 만든 계정과 일치)
MONGO_URI=mongodb://fms_admin:fms_password@127.0.0.1:27017/fms_db?authSource=admin

# 맵 파일 폴더 — OS별로 수정!
#   Linux  : /home/<사용자>/map
#   macOS  : /Users/<사용자>/map
#   Windows: C:/Users/<사용자>/map
MAPS_DIR=/home/js/map

# ── Ollama (LLM) ──────────────────────────────
# localhost는 IPv6(::1)로 풀려 실패할 수 있어 127.0.0.1 권장. GPU 서버 분리 시 그 IP.
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=llava
OLLAMA_NL_MODEL=qwen2.5:7b
OLLAMA_CMD_MODEL=qwen2.5:7b
OLLAMA_CHAT_MODEL=exaone3.5:latest

# slam_toolbox 초기화 서비스명 (rosbridge 경유)
SLAM_RESET_SERVICE=/slam_toolbox/reset

# ── 레거시(현재 코드 미사용) — 참고용으로 남겨둠 ──
ROS_DOMAIN_ID=49
ROS2_SETUP=/opt/ros/jazzy/setup.bash
ROS2_WS_SETUP=~/Desktop/ros_project/install/setup.bash
CARTOGRAPHER_CONFIG_DIR=~/robot_ws/install/turtlebot3_cartographer/share/turtlebot3_cartographer/config
CARTOGRAPHER_CONFIG_FILE=turtlebot3_lds_2d.lua
OLLAMA_KEEP_ALIVE=-1
```

---

## 6. 트러블슈팅

- **대시보드는 뜨는데 로봇 데이터가 없음** → ROS2/rosbridge 미실행 또는 `ROSBRIDGE_URL` 불일치. §4 확인.
- **백엔드가 MongoDB 연결 실패** → `MONGO_URI` 계정/포트 확인, MongoDB 서비스 기동 여부 확인.
- **AI 응답이 안 옴** → `ollama serve` 실행 여부와 모델 3개 pull 여부(`ollama list`) 확인.
- **맵 목록이 비어 있음** → `MAPS_DIR` 경로가 OS에 맞는지, 그 폴더에 `*.pgm`/`*.yaml` 이 있는지 확인.
- **음성 명령(STT) 오류** → `python3` + `faster-whisper` 설치 필요. Windows는 `python3` 별칭 문제일 수 있음(선택 기능이라 무시 가능).
- **빌드 산출물은 옮기지 말 것** → `build/`·`install/`·`dist/`·`node_modules/` 는 OS·경로 종속. 새 PC에서 재빌드/재설치.

---

## 7. 가상 테스트봇 `TEST-BOT1` ~ `TEST-BOT4` (rosbridge 미경유)

ROS2/rosbridge 없이 **백엔드 안에서만** 동작하는 시뮬레이션 로봇 **4대**입니다. 실제 로봇과 **동일한 메시지 파이프라인**(텔레메트리·태스크매니저·경로탐색)을 타며, 기본 동작은 터틀봇과 같습니다.

- 항상 온라인으로 표시되고 지도에 위치가 찍힙니다 (odom/amcl/battery 주기 주입).
- 태스크를 배정하면 목적지까지 직선 주행하며 경유 노드·코너 회전을 처리합니다.
- 이동은 항상 목표에 도달하므로 태스크는 **항상 성공(COMPLETED)** 합니다.
- 프론트 **플릿 탭**의 로봇 목록·추천 로봇에 `TEST-BOT1`~`TEST-BOT4`(도메인 99~102)로 나타나며, "등록만/할당" 모두 사용 가능합니다. 여러 대를 동시에 배차해 다중 로봇/충돌 회피 테스트도 가능합니다.

### DB 등록 (자동 + 수동)

백엔드가 부팅 후 각 가상 봇의 텔레메트리를 감지하면 `fleet_robots` 컬렉션에 **자동 등록**(`autoRegister`)하므로 별도 작업이 없어도 됩니다. 다만 시드 데이터로 **미리 넣어두려면** mongosh에서 아래를 실행하세요 (idempotent — 이미 있으면 그대로 둠):

```js
// mongosh "mongodb://fms_admin:fms_password@127.0.0.1:27017/fms_db?authSource=admin"
use fms_db
["TEST-BOT1", "TEST-BOT2", "TEST-BOT3", "TEST-BOT4"].forEach((id, i) =>
  db.fleet_robots.updateOne(
    { robot_id: id },
    { $setOnInsert: {
        robot_id: id,
        ip: "auto",
        ros_domain_id: 0,
        status: "IDLE",
        location: null,
        lastNode: null,
        pose_x: i * 0.5, pose_y: 0, yaw: 0,
        battery: 100,
        lastSeenAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      } },
    { upsert: true }
  )
);
```

> 시작 위치는 각각 `(0,0)`, `(0.5,0)`, `(1.0,0)`, `(1.5,0)` 으로 겹치지 않게 배치됩니다. 지도에서 봇을 선택하고 우클릭 드래그로 초기위치(initialpose)를 잡으면 실제 로봇처럼 가까운 노드로 `location` 이 설정되어 배차 시 자연스러운 경로가 나옵니다.
