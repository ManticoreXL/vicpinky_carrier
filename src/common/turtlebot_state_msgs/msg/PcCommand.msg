# PC(미션 두뇌)가 로컬 중앙 노드로 내리는 지시 (/{bot_id}/pc_command)
# — 위에서 아래로

string command
# 'DEPLOY'         : 하차 시작 지시 (빅핑키 다리 내려간 뒤 PC 가 출발 명령)
# 'GO_LOAD'        : 배달할 사람 아직 남음. 빅핑키로 올라가 물품 받으러 가라
# 'START_RETURN'   : 배달 모두 끝남. 충전소로 복귀하라
# 'PARK_AUTHORIZE' : 주차 허가 (4→1 순서로 PC 가 한 대씩 내려줌)
# 'SET_ERROR'      : 전도 등 비정상 판정. 로봇을 ERROR(종착)로 전환

builtin_interfaces/Time stamp
