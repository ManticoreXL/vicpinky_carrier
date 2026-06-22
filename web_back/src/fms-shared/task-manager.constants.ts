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
