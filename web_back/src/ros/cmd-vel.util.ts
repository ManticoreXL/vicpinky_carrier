import { TopicPublishPayload } from './ros.types';

// cmd_vel 발행 페이로드 빌더 — vicpinky=geometry_msgs/Twist, 그 외(tb3)=geometry_msgs/TwistStamped.
// 프론트 수동조종(gateway handleCmdVel)과 자연어 명령 실행(command.service)이 공유한다.
// (task-execution 은 domain_bridge 능력 기반의 cmdVelTarget 를 별도로 쓰므로 통합 대상이 아니다.)
export function buildCmdVel(
  botId: string,
  linear: number,
  angular: number,
): TopicPublishPayload {
  const isVicPinky = botId === 'vicpinky';
  const twist = {
    linear:  { x: linear, y: 0.0, z: 0.0 },
    angular: { x: 0.0, y: 0.0, z: angular },
  };
  return {
    topicName: `/${botId}/cmd_vel`,
    messageType: isVicPinky ? 'geometry_msgs/Twist' : 'geometry_msgs/TwistStamped',
    message: isVicPinky
      ? twist
      : { header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' }, twist },
  };
}
