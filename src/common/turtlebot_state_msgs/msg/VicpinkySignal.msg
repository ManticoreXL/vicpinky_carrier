# 빅핑키가 마커 인식 후 로봇으로 직접 쏘는 신호 (/{bot_id}/vicpinky_signal)
# — 빅핑키에서 아래로
#
# 빅핑키 카메라가 "이 로봇이 위에 올라옴" 을 인식하고, PC 에서 받은
# 남은 구호자 수에 따라 다음 행동을 분기해서 쏜다.

string signal
# 'LOAD'  : 아직 구호자 남음 → OMX 에서 물품 받아라 (LOADING 으로)
# 'PARK'  : 구호자 없음(또는 주차 차례) → 주차해라 (PARKING 으로)

builtin_interfaces/Time stamp
