// TaskManagerService 동작 상수

export const LOOP_MS          = 1_000;     // 오프라인/온라인 전환 반응 속도 (1s 주기 감시)
export const ONLINE_MS          = 5_000;
// 하드웨어 OFF 시 빠른 오프라인 감지. 로봇은 odom/imu를 10~30Hz로 발행하므로
// 6s 무수신이면 사실상 끊김. (과거 20s는 전환이 너무 느렸음)
export const OFFLINE_AFTER_MS   = 6_000;
export const AMCL_TIMEOUT_MS    = 60_000;  // nav2 TF 초기화 여유 — 60s 대기 후 판단
export const AMCL_RESUME_MS     = 30_000;  // AMCL 복구 후 이 시간 내 AMCL 수신 시 재시도 판단 기준
export const FALL_THRESH_RAD  = Math.PI / 4; // 45° 이상 기울면 전복 판정

// 위치 감지 반경 (노드 위주 경로)
export const NODE_PASS_M   = 1.5;  // 중간 노드 통과 감지
export const NODE_ARRIVE_M = 0.5;  // 최종 목적지 도착 감지 (action result 백업)
// 가상 테스트봇 전용 — 목표 노드에 정확히 스냅하므로 도착 프레임 거리≈0. 최소 임계값으로 두어 노드에 실제 올라왔을 때만 도착 처리.
export const TEST_ARRIVE_M = 0.05;

// 충전/배터리 임계 (env로 조정). 이전엔 robot-monitor·task-manager·dispatch 에 흩어져 있던 것을 통합.
export const CHARGE_TARGET_PCT = Number(process.env.CHARGE_TARGET_PCT ?? 80);     // 충전 완료 목표(%) — 도달 시 IDLE/퇴거
export const LOW_BATTERY_PCT   = Number(process.env.LOW_BATTERY_PCT ?? 20);       // 충전 필요 하한(%) — 미만이면 관제 알림
export const SUPPLY_TIMEOUT_MS = Number(process.env.SUPPLY_TIMEOUT_MS ?? 30_000); // 보급 비전 적재 대기 타임아웃(ms)
