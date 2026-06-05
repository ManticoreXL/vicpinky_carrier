import dynamixel_sdk        # DYNAMIXEL SDK를 불러옵니다

class MirrorMotorControl:

    def __init__(self, device_name, id_l , id_r, baudrate=1000000):
        # 모터 번호 및 버전 설정
        self.protocol_version = 2.0
        self.id_l = id_l  # 12
        self.id_r = id_r  # 13
        self.baudrate=baudrate

        # 주소값 설정
        self.addr_torque_en = 64
        self.addr_profile_vel = 112
        self.addr_goal_pos = 116
        self.addr_moving = 122
        self.addr_present_load = 126
        self.addr_present_pos = 132

        self.len_goal_pos = 4 
        self.len_present_load = 2
        self.len_present_pos = 4

        # 포트 및 패킷 핸들러 초기화
        self.portHandler = dynamixel_sdk.PortHandler(device_name)
        self.packetHandler = dynamixel_sdk.PacketHandler(self.protocol_version)
        # 동시 읽기 쓰기 객체 생성
        self.groupSyncWrite = dynamixel_sdk.GroupSyncWrite(self.portHandler, self.packetHandler, self.addr_goal_pos, self.len_goal_pos)
        self.groupSyncReadPos = dynamixel_sdk.GroupSyncRead(self.portHandler, self.packetHandler, self.addr_present_pos, self.len_present_pos)
        self.groupSyncReadLoad = dynamixel_sdk.GroupSyncRead(self.portHandler, self.packetHandler, self.addr_present_load, self.len_present_load)

        self._connect(baudrate)
        self.set_torque()

    def _connect(self, baudrate):
        # 포트 열기 및 통신속도 설정
        try:
            self.portHandler.openPort() 
            print("Successfully opened the port!")
            self.portHandler.setBaudRate(baudrate)
            print("Successfully set baud rate!")

        except Exception as e:
            raise Exception(f"장치의 포트를 열 수 없습니다!")
    
    def set_torque(self, enable=True):
        # 모터의 토크 켜기
        torque_val = 1 if enable else 0
        self.packetHandler.write1ByteTxRx(self.portHandler, self.id_l, self.addr_torque_en, torque_val)
        self.packetHandler.write1ByteTxRx(self.portHandler, self.id_r, self.addr_torque_en, torque_val)
        state = "en" if enable else "dis"
        print(f"Motor touque {state}abled!")

    def set_profile_vel(self,vel):
        # 각도제어 속력 설정
        profile_vel=vel # 0은 최대 속도

        self.packetHandler.write4ByteTxRx(self.portHandler, self.id_l, self.addr_profile_vel, profile_vel)
        self.packetHandler.write4ByteTxRx(self.portHandler, self.id_r, self.addr_profile_vel, profile_vel)
            
    def set_angle(self, goal_angle_1):
        # 모터 각도 설정
        goal_position_l=goal_angle_1
        goal_position_r=4095-goal_position_l

        param_goal_position_l=goal_position_l.to_bytes(self.len_goal_pos, byteorder='little')
        param_goal_position_r=goal_position_r.to_bytes(self.len_goal_pos, byteorder='little')

        self.groupSyncWrite.addParam(self.id_l, param_goal_position_l)
        self.groupSyncWrite.addParam(self.id_r, param_goal_position_r)

        # 패킷 전송
        dxl_comm_result = self.groupSyncWrite.txPacket()

        if dxl_comm_result != dynamixel_sdk.COMM_SUCCESS:
            print(self.packetHandler.getTxRxResult(dxl_comm_result))

        # 파라미터 비우기
        self.groupSyncWrite.clearParam()

    def read_angle(self):
        # 모터의 현재 각도 읽기
        self.groupSyncReadPos.addParam(self.id_l)
        self.groupSyncReadPos.addParam(self.id_r)

        dxl_comm_result = self.groupSyncReadPos.txRxPacket()

        if dxl_comm_result != dynamixel_sdk.COMM_SUCCESS:
            err_msg=self.packetHandler.getTxRxResult(dxl_comm_result)
            self.groupSyncReadPos.clearParam()
            raise Exception(f"Failed to read motor position!: {err_msg}")
        
        present_pos_l = self.groupSyncReadPos.getData(self.id_l,self.addr_present_pos,self.len_present_pos)
        present_pos_r = self.groupSyncReadPos.getData(self.id_r,self.addr_present_pos,self.len_present_pos)

        self.groupSyncReadPos.clearParam()

        return present_pos_l, present_pos_r
    
    def read_load(self):
        # 모터의 현재 부하 읽기
        self.groupSyncReadLoad.addParam(self.id_l)
        self.groupSyncReadLoad.addParam(self.id_r)

        dxl_comm_result = self.groupSyncReadLoad.txRxPacket()

        if dxl_comm_result != dynamixel_sdk.COMM_SUCCESS:
            err_msg=self.packetHandler.getTxRxResult(dxl_comm_result)
            self.groupSyncReadLoad.clearParam()
            raise Exception(f"Failed to read motor position!: {err_msg}")
        
        present_load_l = self.groupSyncReadLoad.getData(self.id_l,self.addr_present_load,self.len_present_load)
        present_load_r = self.groupSyncReadLoad.getData(self.id_r,self.addr_present_load,self.len_present_load)

        self.groupSyncReadLoad.clearParam()

        return present_load_l, present_load_r
    
    def is_moving(self,motor=0):
        # 모터가 작동중인지 확인 (모터 번호 0은 왼쪽 그 외 오른쪽)
        if motor is 0:
            motor_id = self.id_l
        else:
            motor_id=self.id_r
        read_data, dxl_comm_result, dxl_error = self.packetHandler.read1ByteTxRx(self.portHandler, motor_id, self.addr_moving)
        return read_data

    def close(self):
        self.set_torque(enable=False)
        self.portHandler.closePort()
        print("Successfully closed the port!")


