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
  actionName: string;          // e.g. "/bigpinky/carrier_task"
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

// ── 터틀봇 토픽 헬퍼 ────────────────────────────────────────────────────────
const TB3_IDS = ['tb3_01', 'tb3_02', 'tb3_03', 'tb3_04'] as const;

function tb3Topics(id: string): RosTopicConfig[] {
  return [
    { name: `/${id}/cmd_vel`,            messageType: 'geometry_msgs/Twist' },
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
  ];
}

// 구독할 토픽 목록
export const SUBSCRIBED_TOPICS: RosTopicConfig[] = [
  // BigPinky
  { name: '/bigpinky/ramp/state',  messageType: 'std_msgs/String' },
  { name: '/bigpinky/battery',     messageType: 'sensor_msgs/BatteryState' },
  { name: '/bigpinky/omx1/state', messageType: 'std_msgs/String' },
  { name: '/bigpinky/omx2/state', messageType: 'std_msgs/String' },

  // TurtleBot3 × 4
  ...TB3_IDS.flatMap(tb3Topics),
];
