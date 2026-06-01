# vicpinky_carrier
AI 융합 로봇 SW 개발자 2기 최종 프로젝트 (4팀)

# 환경 설정
1. ROS2 환경 불러오기
    ```bash
    source /opt/ros/jazzy/setup.bash
    ```

2. 레포지토리 가져오기
    ```bash
    cd ~/
    git clone https://github.com/ManticoreXL/vicpinky_carrier
    ```

3. 외부 의존성 소스 로드
    ```bash
    cd ~/vicpinky_carrier
    vcs import src < vicpinky_carrier.repos
    ```

4. 의존성 패키지 설치
    ```bash
    sudo apt-get update
    rosdep update
    rosdep install --from-paths src --ignore-src -y --rosdistro jazzy
    ```

5. 패키지 빌드
    ```bash
    colcon build --symlink-install
    ```

# 트리비아
- 패키지 빌드 중 경고 발생시
    ```bash
    sudo rm -rf /usr/lib/python3/dist-packages/pytest_repeat.egg-info/
    pip install pytest-repeat
    ```