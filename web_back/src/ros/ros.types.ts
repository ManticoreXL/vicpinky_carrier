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

// 구독할 토픽 목록
export const SUBSCRIBED_TOPICS: RosTopicConfig[] = [
  { name: '/bigpinky/ramp/state',         messageType: 'std_msgs/String' },
  { name: '/bigpinky/battery',            messageType: 'sensor_msgs/BatteryState' },
  { name: '/bigpinky/omx1/state',         messageType: 'std_msgs/String' },
  { name: '/bigpinky/omx2/state',         messageType: 'std_msgs/String' },
  { name: '/turtlebot1/mode',             messageType: 'std_msgs/String' },
  { name: '/turtlebot1/battery',          messageType: 'sensor_msgs/BatteryState' },
  { name: '/turtlebot1/yolo/person_detected', messageType: 'std_msgs/Bool' },
  { name: '/turtlebot2/mode',             messageType: 'std_msgs/String' },
  { name: '/turtlebot2/battery',          messageType: 'sensor_msgs/BatteryState' },
  { name: '/turtlebot2/yolo/person_detected', messageType: 'std_msgs/Bool' },
  { name: '/turtlebot1/cmd_vel', messageType: 'geometry_msgs/Twist' },  // 추가
  { name: '/turtlebot2/cmd_vel', messageType: 'geometry_msgs/Twist' },  // 추가
  { name: '/turtlebot3/cmd_vel', messageType: 'geometry_msgs/Twist' },  // 추가
  { name: '/turtlebot4/cmd_vel', messageType: 'geometry_msgs/Twist' },  // 추가
];
