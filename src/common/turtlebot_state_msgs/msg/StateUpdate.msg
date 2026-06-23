# 기능 노드가 '작업 완료/상태 보고'를 올리는 메시지 (/state_update)

string requester         # 보낸 노드 이름

string field             # 'mission' 또는 'ramp'

# field='mission' 일 때: 방금 끝낸 작업 (다음 작업은 중앙 노드가 결정)
string completed_stage

# field='ramp' 일 때: 경사로 물리 상태
string ramp_state        # 'Open' / 'Closed'

# 무선 환경 중복/늦은 보고 방어
uint32 seq
builtin_interfaces/Time stamp