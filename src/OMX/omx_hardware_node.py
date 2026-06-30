#!/usr/bin/env python3
"""
OMX 하드웨어 노드 (PID 튜닝, 안전 클리핑, 드라이브 모드 설정 패치본)
"""

import sys
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Float32MultiArray
from dynamixel_sdk import *

class OMXHardwareNode(Node):
    def __init__(self) -> None:
        super().__init__("omx_hardware_node")
        
        self.declare_parameter("usb_port", "/dev/ttyACM1") 
        self.declare_parameter("baud_rate", 1000000)       
        
        self.usb_port = self.get_parameter("usb_port").get_parameter_value().string_value
        self.baud_rate = self.get_parameter("baud_rate").get_parameter_value().integer_value
        
        self.joint_names = ['shoulder_pan', 'shoulder_lift', 'elbow_flex',
                            'wrist_flex', 'wrist_roll', 'gripper']
        self.dxl_ids = [11, 12, 13, 14, 15, 16]
        self.GRIPPER_ID = 16
        self.ELBOW_ID = 13

        # 하드웨어 안전 임계값 (라디안 단위, 급격한 움직임 방지)
        self.MAX_STEP_RADIAN = 0.5 

        # 다이나믹셀 주소 상수
        self.ADDR_TORQUE_ENABLE    = 64
        self.ADDR_OPERATING_MODE   = 11
        self.ADDR_DRIVE_MODE       = 10
        self.ADDR_PRESENT_POSITION = 132
        self.ADDR_GOAL_POSITION    = 116
        
        # PID 게인 주소
        self.ADDR_POS_P_GAIN = 84
        self.ADDR_POS_I_GAIN = 82
        self.ADDR_POS_D_GAIN = 80

        self.portHandler   = PortHandler(self.usb_port)
        self.packetHandler = PacketHandler(2.0)
        
        self.groupSyncWrite = GroupSyncWrite(self.portHandler, self.packetHandler, self.ADDR_GOAL_POSITION, 4)
        self.groupSyncRead = GroupSyncRead(self.portHandler, self.packetHandler, self.ADDR_PRESENT_POSITION, 4)
        
        # 이전 위치 저장용 (안전 클리핑용)
        self.last_valid_positions = {id: 0.0 for id in self.dxl_ids}

        self._init_connection()
        
        self.state_pub = self.create_publisher(JointState, "/omx/follower_state", 10)
        self.cmd_sub   = self.create_subscription(Float32MultiArray, "/omx/joint_commands", self._joint_cmd_callback, 10)
        self.timer = self.create_timer(1.0 / 15.0, self._publish_real_state)

    def _init_connection(self):
        if not self.portHandler.openPort() or not self.portHandler.setBaudRate(self.baud_rate):
            sys.exit(1)
            
        for dxl_id in self.dxl_ids:
            self.groupSyncRead.addParam(dxl_id)
            # 모드 설정 및 드라이브 모드 초기화 (Normal: 0)
            mode = 5 if dxl_id == self.GRIPPER_ID else 4
            self.packetHandler.write1ByteTxRx(self.portHandler, dxl_id, self.ADDR_OPERATING_MODE, mode)
            self.packetHandler.write1ByteTxRx(self.portHandler, dxl_id, self.ADDR_DRIVE_MODE, 0)
        
        # PID 설정 (Elbow Flex)
        self.packetHandler.write2ByteTxRx(self.portHandler, self.ELBOW_ID, self.ADDR_POS_P_GAIN, 1500)
        self.packetHandler.write2ByteTxRx(self.portHandler, self.ELBOW_ID, self.ADDR_POS_I_GAIN, 0)
        self.packetHandler.write2ByteTxRx(self.portHandler, self.ELBOW_ID, self.ADDR_POS_D_GAIN, 600)
        
        self.set_torque(1)

    def set_torque(self, enable: int) -> None:
        for dxl_id in self.dxl_ids:
            self.packetHandler.write1ByteTxRx(self.portHandler, dxl_id, self.ADDR_TORQUE_ENABLE, enable)

    def _joint_cmd_callback(self, msg: Float32MultiArray) -> None:
        if len(msg.data) < 6: return
        
        self.groupSyncWrite.clearParam()
        for i, dxl_id in enumerate(self.dxl_ids):
            leader_rad = msg.data[i]
        
            # 2. [그리퍼 전용 오프셋 패치] 
            # 리더암 그리퍼(0.144194)와 팔로우암 그리퍼(0.027612)의 차이인 0.116582를 빼줌
            if dxl_id == self.GRIPPER_ID:  # 또는 if i == 5:
                target_rad = leader_rad - 0.206582
            else:
                target_rad = leader_rad  # 나머지 관절(1~5번)은 오프셋 없이 그대로 추종
            
            # [Safety] 클리핑 로직: 이전 값과 비교하여 너무 큰 차이는 제한
            if abs(target_rad - self.last_valid_positions[dxl_id]) > self.MAX_STEP_RADIAN:
                target_rad = self.last_valid_positions[dxl_id] + \
                             (self.MAX_STEP_RADIAN if target_rad > self.last_valid_positions[dxl_id] else -self.MAX_STEP_RADIAN)
            
            self.last_valid_positions[dxl_id] = target_rad
            
            # 라디안 변환 (Pulse 변환 로직 포함)
            pulse = int((target_rad * 2048 / 3.141592) + 2048)
            param = [DXL_LOBYTE(DXL_LOWORD(pulse)), DXL_HIBYTE(DXL_LOWORD(pulse)), 
                     DXL_LOBYTE(DXL_HIWORD(pulse)), DXL_HIBYTE(DXL_HIWORD(pulse))]
            self.groupSyncWrite.addParam(dxl_id, param)
                
        self.groupSyncWrite.txPacket()

    def _publish_real_state(self) -> None:
        if self.groupSyncRead.txRxPacket() != COMM_SUCCESS: return
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = self.joint_names
        
        positions = []
        for dxl_id in self.dxl_ids:
            raw = self.groupSyncRead.getData(dxl_id, self.ADDR_PRESENT_POSITION, 4)
            if raw > 2147483647: raw -= 4294967296
            radian = (raw - 2048) * (3.141592 / 2048)
            positions.append(radian)
            self.last_valid_positions[dxl_id] = radian
            
        msg.position = positions
        self.state_pub.publish(msg)

    def shutdown_node(self) -> None:
        self.set_torque(0)
        self.portHandler.closePort()

def main(args=None) -> None:
    rclpy.init(args=args)
    node = OMXHardwareNode()
    try: rclpy.spin(node)
    except KeyboardInterrupt: pass
    finally: node.shutdown_node()