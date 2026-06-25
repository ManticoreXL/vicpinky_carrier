# 로컬 중앙 노드가 보유·발행하는 그 로봇 한 대의 상태 (/{bot_id}/robot_state)
# 구호봇/탐사봇 공용 (탐사봇은 LOADING 단계를 안 쓸 뿐)

# ── 현재 작업 단계 ──
# ONBOARD  : 빅핑키 위에 실려 있음 (시작 상태)
# LOADING  : OMX 에서 구호물품 받는 중 (구호봇 전용)
# DEPLOY   : 빅핑키에서 하차하는 중
# ACTIVE   : 임무 수행 중 (탐사봇=매핑/욜로, 구호봇=배달)
# TRACE    : 라인트레이싱으로 빅핑키 위로 올라가는 중
# RETURN   : 충전소 옆으로 이동하는 중
# STANDBY  : 충전소 도착, 주차 차례 대기 중
# PARKING  : 주차 동작 중
# PARKED   : 주차 완료 (정상 종착)
# ERROR    : 비정상(전도 등). 회복 불가 종착
string stage

# ── 주차 허가 여부 ──
# PC 가 4→1 순서로 내려주는 허가. true 면 TRACE 시 OMX 가 아니라
# 자기 마커 위치로 가서 주차한다.
bool parking_authorized

# ── 메타 ──
string bot_id            # 'tb3_02' 등
uint8  marker_id         # 이 로봇의 주차 마커 번호 (1~4)
string last_changed_by   # 마지막으로 상태를 바꾼 출처 ('node'/'pc'/'vicpinky')
uint32 stage_seq         # 단계가 바뀔 때마다 증가 (구독자 중복 처리 방지)
builtin_interfaces/Time stamp
