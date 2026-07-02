#!/usr/bin/env python3
"""
액션·서비스 도메인 릴레이 — domain_bridge 가 지원하지 않는 actions:/services: 를 대체한다.

배경:
  설치된 domain_bridge(jazzy 0.5.0)는 topic 만 중계하고 actions:/services: 섹션은
  조용히 무시한다(라이브러리에 action/service 브릿지 심볼이 아예 없음, upstream issue #11 미구현).
  domain_bridge_*.yaml 의 actions:/services: 블록(navigate_to_pose·line_trace·deploy·
  run_diagnosis·ramp_control)은 그래서 문서/BridgeMap 참조용으로만 남아있고, 실제 중계는
  이 스크립트가 전담한다.

동작:
  한 프로세스 안에서 도메인별 rclpy Context 를 따로 띄우고,
    - 허브 도메인(49): 액션/서비스 '서버' 를 연다 → rosbridge 의 클라이언트가 여기에 붙는다.
    - 로봇 도메인(40~44): 액션/서비스 '클라이언트' 로 실서버에 붙는다.
  액션은 goal/feedback/result/cancel 을, 서비스는 request/response 를 그대로 양방향 중계한다.
  (domain_bridge 가 topic 에 대해 하는 일을, 액션·서비스에 대해 대신 해주는 얇은 프록시)

실행:
  start_domain_bridge.sh 가 domain_bridge 와 함께 백그라운드로 띄운다.
  domain_bridge 와 '동일한' 환경이 필요하다:
    - 워크스페이스 source (vicpinky_carrier_interfaces, turtlebot_state_msgs 임포트용)
    - FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_unicast.xml (원격 로봇 도메인을 유니캐스트로 디스커버리)
  도메인 49(로컬 rosbridge)는 same-host SHM 으로, 로봇 도메인(원격)은 유니캐스트 peer 로 발견된다
  — domain_bridge 가 이미 같은 방식으로 각 도메인↔49를 중계하고 있으므로 동일하게 성립한다.
"""

import threading
import time

import rclpy
from rclpy.action import ActionClient, ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor

from action_msgs.msg import GoalStatus

from vicpinky_carrier_interfaces.action import RampControl
from nav2_msgs.action import NavigateToPose
from turtlebot_state_msgs.srv import LineTrace, Deploy
from std_srvs.srv import Trigger


# 중계할 액션 목록 — domain_bridge_*.yaml 의 (동작하지 않는) actions: 섹션을 대체한다.
#   hub_name   : 허브(49)에서 rosbridge 클라이언트가 붙는 이름 (yaml 의 key)
#   robot_name : 로봇 도메인 실서버 이름 (yaml 의 remap. 없으면 hub_name 과 동일 — 예: ramp_control)
#   marker_trace 등 액션을 추가하려면 여기에 항목을 한 줄 더 넣기만 하면 된다.
ACTION_RELAYS = [
    {'hub_name': '/ramp_control',           'robot_name': '/ramp_control',     'type': RampControl,    'hub_domain': 49, 'robot_domain': 40},
    {'hub_name': '/tb3_01/navigate_to_pose', 'robot_name': '/navigate_to_pose', 'type': NavigateToPose, 'hub_domain': 49, 'robot_domain': 41},
    {'hub_name': '/tb3_02/navigate_to_pose', 'robot_name': '/navigate_to_pose', 'type': NavigateToPose, 'hub_domain': 49, 'robot_domain': 42},
    {'hub_name': '/tb3_03/navigate_to_pose', 'robot_name': '/navigate_to_pose', 'type': NavigateToPose, 'hub_domain': 49, 'robot_domain': 43},
    {'hub_name': '/tb3_04/navigate_to_pose', 'robot_name': '/navigate_to_pose', 'type': NavigateToPose, 'hub_domain': 49, 'robot_domain': 44},
    # {'hub_name': '/vicpinky/marker_trace', 'robot_name': '/marker_trace', 'type': MarkerTrace, 'hub_domain': 49, 'robot_domain': 40},
]

# 중계할 서비스 목록 — domain_bridge_*.yaml 의 (동작하지 않는) services: 섹션을 대체한다. 필드 구성 동일.
SERVICE_RELAYS = [
    {'hub_name': '/vicpinky/run_diagnosis', 'robot_name': '/vicpinky/run_diagnosis', 'type': Trigger,   'hub_domain': 49, 'robot_domain': 40},
    {'hub_name': '/tb3_01/line_trace',      'robot_name': '/line_trace',             'type': LineTrace, 'hub_domain': 49, 'robot_domain': 41},
    {'hub_name': '/tb3_02/line_trace',      'robot_name': '/line_trace',             'type': LineTrace, 'hub_domain': 49, 'robot_domain': 42},
    {'hub_name': '/tb3_03/line_trace',      'robot_name': '/line_trace',             'type': LineTrace, 'hub_domain': 49, 'robot_domain': 43},
    {'hub_name': '/tb3_03/deploy',          'robot_name': '/deploy',                 'type': Deploy,    'hub_domain': 49, 'robot_domain': 43},
    {'hub_name': '/tb3_04/line_trace',      'robot_name': '/line_trace',             'type': LineTrace, 'hub_domain': 49, 'robot_domain': 44},
]

# 로봇측 실서버가 뜰 때까지 기다리는 최대 시간(초). 초과하면 goal/요청을 abort/실패 처리.
SERVER_WAIT_SEC = 5.0
# 서비스 응답 대기 타임아웃(초) — 액션과 달리 진행 중 feedback이 없어 통짜로 기다렸다 끊는다.
SERVICE_CALL_TIMEOUT_SEC = 10.0


class ActionRelay:
    """액션 하나를 허브(server)↔로봇(client)로 중계."""

    def __init__(self, spec, hub_node, robot_node):
        self.hub_name = spec['hub_name']
        self.robot_name = spec.get('robot_name', self.hub_name)
        self.action_type = spec['type']
        self.log = hub_node.get_logger()

        # 로봇 도메인: 실서버로 goal 을 보내는 클라이언트
        self._client = ActionClient(
            robot_node, self.action_type, self.robot_name,
            callback_group=ReentrantCallbackGroup(),
        )

        # 허브 도메인(49): rosbridge 가 붙는 서버.
        #   execute 가 결과를 기다리며 블로킹하므로 취소가 동시에 처리되도록 Reentrant 그룹 + 멀티스레드 executor 사용.
        self._server = ActionServer(
            hub_node, self.action_type, self.hub_name,
            execute_callback=self._execute,
            goal_callback=lambda goal_request: GoalResponse.ACCEPT,
            cancel_callback=lambda goal_handle: CancelResponse.ACCEPT,
            callback_group=ReentrantCallbackGroup(),
        )
        self.log.info(f'액션 릴레이 준비: {self.hub_name} → {self.robot_name}  (허브 서버 ↔ 로봇 클라이언트)')

    def _execute(self, hub_goal_handle):
        """허브에서 받은 goal 을 로봇으로 전달하고 feedback/result 를 되돌린다."""
        request = hub_goal_handle.request
        result_cls = self.action_type.Result

        if not self._client.wait_for_server(timeout_sec=SERVER_WAIT_SEC):
            self.log.warn(f'{self.hub_name}: 로봇측({self.robot_name}) 서버 없음 → abort')
            hub_goal_handle.abort()
            return result_cls()

        done = threading.Event()
        box = {}  # 'robot_gh' / 'wrapped'(결과) / 'rejected'

        # 아래 콜백들은 '로봇 도메인' executor 스레드에서 호출된다.
        def on_feedback(feedback_msg):
            hub_goal_handle.publish_feedback(feedback_msg.feedback)

        def on_result(future):
            box['wrapped'] = future.result()  # .status / .result 포함
            done.set()

        def on_goal_response(future):
            robot_gh = future.result()
            if not robot_gh.accepted:
                box['rejected'] = True
                done.set()
                return
            box['robot_gh'] = robot_gh
            robot_gh.get_result_async().add_done_callback(on_result)

        send_future = self._client.send_goal_async(request, feedback_callback=on_feedback)
        send_future.add_done_callback(on_goal_response)

        # 결과를 기다리며(허브측 취소 요청을 감시해 로봇 goal 로 전파).
        cancel_forwarded = False
        while not done.wait(timeout=0.1):
            if hub_goal_handle.is_cancel_requested and not cancel_forwarded and 'robot_gh' in box:
                cancel_forwarded = True
                self.log.info(f'{self.hub_name}: 취소 요청 → 로봇으로 전파')
                box['robot_gh'].cancel_goal_async()

        if box.get('rejected'):
            self.log.warn(f'{self.hub_name}: 로봇측이 goal 거부 → abort')
            hub_goal_handle.abort()
            return result_cls()

        wrapped = box['wrapped']
        status = wrapped.status
        # 허브 goal 의 종료 상태를 로봇 결과의 상태에 그대로 맞춘다(투명 중계).
        try:
            if status == GoalStatus.STATUS_SUCCEEDED:
                hub_goal_handle.succeed()
            elif status == GoalStatus.STATUS_CANCELED:
                hub_goal_handle.canceled()
            else:
                hub_goal_handle.abort()
        except Exception as exc:
            self.log.error(f'{self.hub_name}: 종료 상태 설정 실패: {exc!r}')
        return wrapped.result


class ServiceRelay:
    """서비스 하나를 허브(server)↔로봇(client)로 중계 — request/response 단순 왕복(feedback/취소 없음)."""

    def __init__(self, spec, hub_node, robot_node):
        self.hub_name = spec['hub_name']
        self.robot_name = spec.get('robot_name', self.hub_name)
        self.service_type = spec['type']
        self.log = hub_node.get_logger()

        # 로봇 도메인: 실서버를 호출하는 클라이언트
        self._client = robot_node.create_client(
            self.service_type, self.robot_name,
            callback_group=ReentrantCallbackGroup(),
        )

        # 허브 도메인(49): rosbridge 가 붙는 서버.
        #   핸들러가 결과를 기다리며 블로킹하므로 Reentrant 그룹 + 멀티스레드 executor 사용(액션과 동일 이유).
        self._server = hub_node.create_service(
            self.service_type, self.hub_name, self._handle,
            callback_group=ReentrantCallbackGroup(),
        )
        self.log.info(f'서비스 릴레이 준비: {self.hub_name} → {self.robot_name}  (허브 서버 ↔ 로봇 클라이언트)')

    def _handle(self, request, response):
        """허브에서 받은 request 를 로봇으로 전달하고 response 필드를 그대로 복사해 되돌린다."""
        if not self._client.wait_for_service(timeout_sec=SERVER_WAIT_SEC):
            self.log.warn(f'{self.hub_name}: 로봇측({self.robot_name}) 서비스 없음 → 빈 응답')
            return response

        done = threading.Event()
        box = {}

        def on_done(future):
            box['result'] = future.result()
            done.set()

        self._client.call_async(request).add_done_callback(on_done)

        if not done.wait(timeout=SERVICE_CALL_TIMEOUT_SEC):
            self.log.warn(f'{self.hub_name}: 로봇측 응답 타임아웃({SERVICE_CALL_TIMEOUT_SEC}s) → 빈 응답')
            return response

        result = box.get('result')
        if result is None:
            self.log.warn(f'{self.hub_name}: 로봇측 응답 실패(예외) → 빈 응답')
            return response

        # 같은 서비스 타입이라 필드명이 동일 — get_fields_and_field_types() 로 타입별 하드코딩 없이 그대로 복사.
        for field in response.get_fields_and_field_types():
            setattr(response, field, getattr(result, field))
        return response


def main():
    # 사용되는 모든 도메인에 대해 컨텍스트/노드/executor 를 하나씩 준비한다.
    specs = ACTION_RELAYS + SERVICE_RELAYS
    domains = set()
    for spec in specs:
        domains.add(spec['hub_domain'])
        domains.add(spec['robot_domain'])

    contexts, nodes, executors, threads = {}, {}, {}, []
    for domain in sorted(domains):
        ctx = rclpy.Context()
        rclpy.init(context=ctx, domain_id=domain)
        node = rclpy.create_node(f'action_relay_d{domain}', context=ctx)
        executor = MultiThreadedExecutor(context=ctx)
        executor.add_node(node)
        contexts[domain] = ctx
        nodes[domain] = node
        executors[domain] = executor

    action_relays = [
        ActionRelay(spec, nodes[spec['hub_domain']], nodes[spec['robot_domain']])
        for spec in ACTION_RELAYS
    ]
    service_relays = [
        ServiceRelay(spec, nodes[spec['hub_domain']], nodes[spec['robot_domain']])
        for spec in SERVICE_RELAYS
    ]

    # 각 도메인 executor 를 별도 스레드에서 spin.
    for executor in executors.values():
        t = threading.Thread(target=executor.spin, daemon=True)
        t.start()
        threads.append(t)

    log = next(iter(nodes.values())).get_logger()
    log.info(f'릴레이 시작 — 액션 {len(action_relays)}개, 서비스 {len(service_relays)}개, 도메인 {sorted(domains)}')

    try:
        while all(ctx.ok() for ctx in contexts.values()):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for executor in executors.values():
            executor.shutdown()
        for node in nodes.values():
            node.destroy_node()
        for ctx in contexts.values():
            try:
                ctx.try_shutdown()
            except Exception:
                pass


if __name__ == '__main__':
    main()
