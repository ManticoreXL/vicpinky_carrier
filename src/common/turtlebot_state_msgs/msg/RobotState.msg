# 중앙 노드가 보유·발행하는 통합 상태 (/robot_state)

# ── 터틀봇 미션 단계 ──
string mission_stage     # 'INIT'/'EXPLORING'/'RESCUE'/'LINE_TRACE'/'MARKER_NAV'/'PARKING'/'PARKED'/'RETURNING'/'DONE'

# ── 빅핑키 경사로 상태 ──
string ramp_state        # 'Open' / 'Closed'

# ── 메타 ──
string last_updated_by   # 마지막으로 상태를 바꾼 노드
uint32 mission_seq       # 미션 단계가 바뀔 때마다 증가 (구독자 중복 처리 방지)
builtin_interfaces/Time stamp