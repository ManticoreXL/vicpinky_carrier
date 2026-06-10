# vicpinky_carrier
AI 융합 로봇 SW 개발자 2기 최종 프로젝트 (4팀)

# 환경 설정
- Operating System: Ubuntu 24.04 LTS
- ROS2 Distribution: ROS2 Jazzy Jalisco
 
1. 가상환경 준비
    ```bash
    python3 -m venv ~/venv/ros
    ```

2. ROS2 환경 불러오기
    ```bash
    source /opt/ros/jazzy/setup.bash
    ```

3. 레포지토리 가져오기
    ```bash
    cd ~/
    git clone https://github.com/ManticoreXL/vicpinky_carrier
    ```

4. 외부 의존성 소스 로드
    ```bash
    cd ~/vicpinky_carrier
    vcs import src < vicpinky_carrier.repos
    ```

5. 의존성 패키지 설치
    ```bash
    sudo apt-get update
    pip install -r requirements.txt
    rosdep update
    rosdep install --from-paths src --ignore-src -y --rosdistro jazzy
    ```

6. 패키지 빌드
    ```bash
    cd src/
    colcon build --symlink-install
    ```

# 트리비아
- 패키지 빌드 중 경고 발생시
    ```bash
    sudo rm -rf /usr/lib/python3/dist-packages/pytest_repeat.egg-info/
    pip install pytest-repeat
    ```