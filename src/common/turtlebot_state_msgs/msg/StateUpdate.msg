# 그 로봇의 기능 노드가 '작업 완료'를 로컬 중앙 노드로 올리는 메시지
# (/{bot_id}/state_update) — 아래에서 위로
#
# 기능 노드는 "내가 방금 끝낸 단계"만 보고한다. 다음 단계가 무엇인지는
# 로컬 중앙 노드가 전이표를 보고 결정한다.

string requester         # 보낸 기능 노드 이름 (예: 'line_follower')
string completed_stage   # 방금 끝낸 단계 (예: 'ACTIVE')
uint32 seq               # 중복/늦은 보고 무시용 (무선 방어)
builtin_interfaces/Time stamp
