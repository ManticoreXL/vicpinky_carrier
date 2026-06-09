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
  status: number;              // 3=succeeded 4=aborted 5=canceled
}

// ── 수동/자율 믹서(twist_mux) 사용 로봇 ─────────────────────────────────────
// 이 로봇들은 cmd_vel_mux 노드가 떠 있어, 수동 명령은 /{botId}/cmd_vel_manual 로
// 보내야 자율(nav2 /cmd_vel_nav)보다 우선 적용된다. 그 외 로봇은 /cmd_vel 직접 발행.
export const MUX_ROBOTS = new Set<string>(['tb3_01']);

/** 수동 cmd_vel 발행 토픽 (믹서 로봇이면 _manual, 아니면 직접) */
export function manualCmdVelTopic(botId: string): string {
  return MUX_ROBOTS.has(botId) ? `/${botId}/cmd_vel_manual` : `/${botId}/cmd_vel`;
}

// ── 터틀봇 토픽 헬퍼 ────────────────────────────────────────────────────────
const TB3_IDS = ['tb3_01', 'tb3_02', 'tb3_03', 'tb3_04'] as const;

function tb3Topics(id: string): RosTopicConfig[] {
  return [
    { name: `/${id}/cmd_vel`,            messageType: 'geometry_msgs/TwistStamped' },
    { name: `/${id}/imu`,               messageType: 'sensor_msgs/Imu' },
    { name: `/${id}/battery_state`,     messageType: 'sensor_msgs/BatteryState' },
    { name: `/${id}/joint_states`,      messageType: 'sensor_msgs/JointState' },
    { name: `/${id}/magnetic_field`,    messageType: 'sensor_msgs/MagneticField' },
    { name: `/${id}/odom`,              messageType: 'nav_msgs/Odometry' },
    { name: `/${id}/robot_description`, messageType: 'std_msgs/String' },
    { name: `/${id}/scan`,              messageType: 'sensor_msgs/LaserScan' },
    { name: `/${id}/sensor_state`,      messageType: 'turtlebot3_msgs/SensorState' },
    { name: `/${id}/mode`,              messageType: 'std_msgs/String' },
    { name: `/${id}/yolo/person_detected`, messageType: 'std_msgs/Bool' },
    { name: `/${id}/map`,              messageType: 'nav_msgs/OccupancyGrid' },
  ];
}

// 구독할 토픽 목록
export const SUBSCRIBED_TOPICS: RosTopicConfig[] = [
  // project_slam (turtlebot3_explorer) — slam_toolbox가 네임스페이스 없이 발행
  { name: '/map',                       messageType: 'nav_msgs/OccupancyGrid' },
  { name: '/pose',                      messageType: 'geometry_msgs/PoseWithCovarianceStamped' },
  { name: '/plan',                      messageType: 'nav_msgs/Path' },

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
