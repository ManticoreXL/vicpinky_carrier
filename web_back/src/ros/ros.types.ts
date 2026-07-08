export interface RosTopicConfig {
  name: string;
  messageType: string;
}

export interface RosServiceConfig {
  name: string;
  serviceType: string;
}

export interface RosMessage {
  topic: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface ServiceCallPayload {
  serviceName: string;
  serviceType: string;
  request: Record<string, unknown>;
}

export interface TopicPublishPayload {
  topicName: string;
  messageType: string;
  message: Record<string, unknown>;
}

// ── Action 관련 타입 ─────────────────────────────────────────────────────────

export interface ActionGoalPayload {
  actionName: string;          // e.g. "/vicpinky/carrier_task"
  actionType: string;          // e.g. "carrier_msgs/action/CarrierTask"
  goal: Record<string, unknown>;
}

export interface ActionCancelPayload {
  actionName: string;
  goalId: string;
}

export interface ActionFeedbackMsg {
  goalId: string;
  actionName: string;
  feedback: Record<string, unknown>;
}

export interface ActionResultMsg {
  goalId: string;
  actionName: string;
  result: Record<string, unknown>;
  status: number;              // ROS2 action_msgs/GoalStatus — 4=succeeded 5=canceled 6=aborted (3=canceling)
}

// ── 터틀봇 토픽 헬퍼 ────────────────────────────────────────────────────────
const TB3_IDS = ['tb3_01', 'tb3_02', 'tb3_03', 'tb3_04'] as const;

function tb3Topics(id: string): RosTopicConfig[] {
  return [
    { name: `/${id}/cmd_vel`,   messageType: 'geometry_msgs/TwistStamped' },
    { name: `/${id}/odom`,      messageType: 'nav_msgs/Odometry' },
    { name: `/${id}/battery_state`, messageType: 'sensor_msgs/BatteryState' },
    { name: `/${id}/imu`,       messageType: 'sensor_msgs/Imu' },
    { name: `/${id}/scan`,      messageType: 'sensor_msgs/LaserScan' },
    { name: `/${id}/amcl_pose`, messageType: 'geometry_msgs/PoseWithCovarianceStamped' },
    { name: `/${id}/plan`,      messageType: 'nav_msgs/Path' },
  ];
}

// 구독할 토픽 목록
export const SUBSCRIBED_TOPICS: RosTopicConfig[] = [
  // project_slam (turtlebot3_explorer) — slam_toolbox가 네임스페이스 없이 발행
  { name: '/map',                       messageType: 'nav_msgs/OccupancyGrid' },
  { name: '/pose',                      messageType: 'geometry_msgs/PoseWithCovarianceStamped' },
  { name: '/plan',                      messageType: 'nav_msgs/Path' },

  // omx 비전 적재 감지 — SUPPLY 태스크 완료 신호 (허브에서 /omx/vision/is_loaded 로 노출)
  { name: '/omx/vision/is_loaded',      messageType: 'std_msgs/Bool' },

  // 정찰(tb3_01) — 맵 + 조난자 보고 (victim/report: JSON 문자열 가정)
  { name: '/tb3_01/map',                messageType: 'nav_msgs/OccupancyGrid' },
  { name: '/victim/report',             messageType: 'std_msgs/String' },
  { name: '/victim/confirmed',          messageType: 'geometry_msgs/PoseStamped' }, // 사람 확정 — map 프레임 좌표(프론트 임시 표시)

  // VicPinky (geometry_msgs/Twist — TwistStamped 아님)
  { name: '/vicpinky/cmd_vel',          messageType: 'geometry_msgs/Twist' },
  { name: '/vicpinky/joint_states',     messageType: 'sensor_msgs/JointState' },
  { name: '/vicpinky/odom',             messageType: 'nav_msgs/Odometry' },
  { name: '/vicpinky/polygon',          messageType: 'geometry_msgs/PolygonStamped' },
  { name: '/vicpinky/robot_description',messageType: 'std_msgs/String' },
  { name: '/vicpinky/scan',             messageType: 'sensor_msgs/LaserScan' },
  { name: '/vicpinky/scan_filtered',    messageType: 'sensor_msgs/LaserScan' },
  { name: '/vicpinky/laser_scan_polygon_filter/transition_event', messageType: 'lifecycle_msgs/TransitionEvent' },
  // 램프 상태 (carrier) — 타입은 로봇 측 실제 정의로 확인 필요
  { name: '/vicpinky/ramp_state',       messageType: 'vicpinky_carrier_interfaces/msg/RampState' },

  // TurtleBot3 × 4
  ...TB3_IDS.flatMap(tb3Topics),
];
