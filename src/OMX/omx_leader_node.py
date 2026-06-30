#!/usr/bin/env python3
import sys
import threading
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
import numpy as np
from dynamixel_sdk import *

# 1. LeRobot 스타일의 제어 테이블 추상화 (XL330 기준 주소 및 데이터 크기 매핑)
XL330_CONTROL_TABLE = {
    "Operating_Mode":   {"address": 11,  "size": 1},
    "Current_Limit":    {"address": 38,  "size": 2}, 
    "Torque_Enable":    {"address": 64,  "size": 1},
    "Goal_Current":     {"address": 102, "size": 2}, 
    "Goal_Position":    {"address": 116, "size": 4}, 
    "Present_Position": {"address": 132, "size": 4},
}

class OMXLeaderLeRobotStyleNode(Node):
    def __init__(self) -> None:
        super().__init__("omx_leader_lerobot_style_node")

        # 2. 하드웨어 설정 객체 구성
        self.config = {
            "usb_port": "/dev/ttyACM0",
            "baud_rate": 1000000,
            "motors": {
                # 이름: [모터ID, 방향인자(1 또는 -1)]
                "shoulder_pan":  [1,  1],
                "shoulder_lift": [2,  1],
                "elbow_flex":    [3,  1],
                "wrist_flex":    [4,  1],
                "wrist_roll":    [5,  1],
                "gripper":       [6,  1],
            },
            "gripper_id": 6,
            "resolution": 4096,
            "homing_offset": 2048,
            "gripper_open_pos": 2700,
            "gripper_open_current": 1193
        }

        # 토픽 퍼블리셔 및 포트 설정
        self.state_pub = self.create_publisher(JointState, "/omx/leader_state", 10)
        self.portHandler = PortHandler(self.config["usb_port"])
        self.packetHandler = PacketHandler(2.0)
        
        pos_info = XL330_CONTROL_TABLE["Present_Position"]
        self.groupSyncRead = GroupSyncRead(
            self.portHandler, self.packetHandler, pos_info["address"], pos_info["size"]
        )

        # [핵심] 소프트웨어 멀티턴(무한 회전)을 위한 과거 상태 및 누적 값 추적 변수
        self.prev_raw_values = {}
        self._cumulative_raw = {}

        # 하드웨어 초기화
        self._init_hardware()
        
        # 동기화 루프 실행
        self._running = True
        self._hw_thread = threading.Thread(target=self._hw_loop, daemon=True)
        self._hw_thread.start()
        self.get_logger().info("★ 리더암 노드 시작 (역방향/정방향 무한 회전 수학적 패치 적용 완료) ★")

    def write_data(self, motor_id: int, data_name: str, value: int) -> bool:
        if data_name not in XL330_CONTROL_TABLE:
            return False
            
        item = XL330_CONTROL_TABLE[data_name]
        addr, size = item["address"], item["size"]

        if size == 1:
            comm, err = self.packetHandler.write1ByteTxRx(self.portHandler, motor_id, addr, value)
        elif size == 2:
            comm, err = self.packetHandler.write2ByteTxRx(self.portHandler, motor_id, addr, value)
        elif size == 4:
            comm, err = self.packetHandler.write4ByteTxRx(self.portHandler, motor_id, addr, value)
        else:
            return False

        return comm == COMM_SUCCESS and err == 0

    def _init_hardware(self) -> None:
        if not self.portHandler.openPort() or not self.portHandler.setBaudRate(self.config["baud_rate"]):
            self.get_logger().error("포트 열기 또는 보드레이트 설정 실패!")
            sys.exit(1)

        gripper_id = self.config["gripper_id"]

        for name, info in self.config["motors"].items():
            motor_id = info[0]
            
            if motor_id == gripper_id:
                # 그리퍼: 집게 벌림 자동 토크 적용
                self.write_data(motor_id, "Torque_Enable", 0)     
                self.write_data(motor_id, "Operating_Mode", 5)    
                self.write_data(motor_id, "Current_Limit", self.config["gripper_open_current"]) 
                self.write_data(motor_id, "Torque_Enable", 1)     
                self.write_data(motor_id, "Goal_Current", self.config["gripper_open_current"])  
                self.write_data(motor_id, "Goal_Position", self.config["gripper_open_pos"])     
            else:
                # 일반 관절: 자유롭게 움직일 수 있도록 토크 OFF 및 멀티턴 모드(4) 적용
                self.write_data(motor_id, "Torque_Enable", 0)
                self.write_data(motor_id, "Operating_Mode", 4) 
            
            self.groupSyncRead.addParam(motor_id)

    def _dxl_to_radian(self, raw_value: int) -> float:
        return (raw_value - self.config["homing_offset"]) * (np.pi / self.config["homing_offset"])

    def _hw_loop(self) -> None:
        pos_info = XL330_CONTROL_TABLE["Present_Position"]
        
        while self._running:
            comm = self.groupSyncRead.txRxPacket()
            if comm != COMM_SUCCESS:
                continue

            joint_names = []
            positions = []

            for name, info in self.config["motors"].items():
                motor_id = info[0]
                direction = info[1]

                if not self.groupSyncRead.isAvailable(motor_id, pos_info["address"], pos_info["size"]):
                    continue

                raw = self.groupSyncRead.getData(motor_id, pos_info["address"], pos_info["size"])
                
                # 1. 32비트 통신 음수 오류 보정
                if raw > 2147483647:
                    raw -= 4294967296
                    
                # 2. 첫 루프 진입 시 현재 위치로 초기화
                if motor_id not in self.prev_raw_values:
                    self.prev_raw_values[motor_id] = raw
                    self._cumulative_raw[motor_id] = raw
                
                # 3. 위상 수학 알고리즘: 값의 차이를 -2048 ~ +2047 구간으로 래핑(Wrapping)
                diff = raw - self.prev_raw_values[motor_id]
                diff = (diff + 2048) % 4096 - 2048
                
                # 4. 계산된 실제 변위를 누적 변수에 더함
                self._cumulative_raw[motor_id] += diff
                self.prev_raw_values[motor_id] = raw
                
                # 5. 끊김 없는 절대 좌표를 기반으로 라디안 계산
                true_raw = self._cumulative_raw[motor_id]
                rad_pos = self._dxl_to_radian(true_raw) * direction
                
                joint_names.append(name)
                positions.append(rad_pos)

            if positions:
                msg = JointState()
                msg.header.stamp = self.get_clock().now().to_msg()
                msg.name = joint_names
                msg.position = positions
                self.state_pub.publish(msg)

    def shutdown_node(self) -> None:
        self._running = False
        self._hw_thread.join(timeout=2.0)
        
        gripper_id = self.config["gripper_id"]
        self.write_data(gripper_id, "Torque_Enable", 0)
        self.write_data(gripper_id, "Operating_Mode", 3)
        
        for name, info in self.config["motors"].items():
            self.write_data(info[0], "Torque_Enable", 0)
            
        self.portHandler.closePort()
        self.get_logger().info("리더암 노드가 안전하게 종료되었습니다.")

def main(args=None) -> None:
    rclpy.init(args=args)
    node = OMXLeaderLeRobotStyleNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.shutdown_node()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()

if __name__ == "__main__":
    main()