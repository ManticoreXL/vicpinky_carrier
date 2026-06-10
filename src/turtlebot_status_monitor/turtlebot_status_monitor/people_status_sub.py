#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PointStamped
import os
from datetime import datetime

class PeopleStatusSubscriber(Node):
    def __init__(self):
        super().__init__('people_status_subscriber')
        
        # 🚑 라즈베리파이 4호차의 AI 확정 토픽 구독
        self.subscription = self.create_subscription(
            PointStamped,
            '/tb3_04/detected_person/relative_pos',
            self.listener_callback,
            10
        )
        
        # 🌟 [상대 경로 고도화] 터미널 실행 위치와 상관없이, 
        # 이 파이썬 파일(people_status_sub.py)이 있는 물리적 폴더 위치를 자동으로 찾아냅니다.
        # 즉, 자동으로 '/home/k/turtlebot3_ws/src/turtlebot_status_monitor/turtlebot_status_monitor'를 가리키게 됩니다.
        current_dir = os.path.dirname(os.path.abspath(__file__))
        self.csv_path = os.path.join(current_dir, 'confirmed_rescue_list.csv')
        
        # CSV 파일 초기화 (파일이 없으면 헤더 생성)
        if not os.path.exists(self.csv_path):
            with open(self.csv_path, 'w', encoding='utf-8') as f:
                f.write("확정_시간,요구조자_ID,상대_X_오프셋,위치_방향,최종_신뢰도(%)\n")
        
        self.get_logger().info("🖥️ [관제 PC] people_status_sub.py 노드가 성공적으로 가동되었습니다.")
        self.get_logger().info(f"📂 확정 리스트 저장 파일 위치: {self.csv_path}")

    def listener_callback(self, msg):
        direction_x = msg.point.x
        confidence = msg.point.z
        
        # 🎯 frame_id 명세 파싱 (예: "tb3_04/person_1" -> "Person_1")
        frame_id_str = msg.header.frame_id
        if "person_" in frame_id_str:
            person_id = "Person_" + frame_id_str.split("person_")[-1]
        else:
            person_id = "Unknown"
            
        # 📐 정규화 좌표 (-1.0 ~ 1.0) 기반 더 정교한 방향 명세 분기
        if direction_x < -0.25:
            position_str = "좌측 편향"
        elif direction_x > 0.25:
            position_str = "우측 편향"
        else:
            position_str = "정면 센터"
        
        # 🚨 관제 PC 터미널에 강력한 경고 로그 출력
        self.get_logger().error(f"⚠️ [요구조자 신호 수신] 4호차 카메라 {position_str}에서 5초간 미동 없는 기절 환자 포착!")
        self.get_logger().warn(f"🚑 [구출 확정] 대상 고유 명칭: {person_id} / AI 분석 신뢰도: {confidence * 100:.1f}%")
        
        # 실제 데이터 저장 시간 생성
        current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # CSV 파일에 누적 기록 저장
        try:
            with open(self.csv_path, 'a', encoding='utf-8') as f:
                f.write(f"{current_time},{person_id},{direction_x:.2f},{position_str},{confidence * 100:.1f}\n")
            self.get_logger().info(f"💾 [리스트 저장] '{person_id}'의 기절 상태 엑셀 기록 업데이트 완료.")
        except Exception as e:
            self.get_logger().error(f"❌ 리스트 파일 영구 기록 중 오류 발생: {e}")

def main(args=None):
    rclpy.init(args=args)
    node = PeopleStatusSubscriber()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()