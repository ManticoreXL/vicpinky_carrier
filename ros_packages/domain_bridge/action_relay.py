#!/usr/bin/env python3
"""
액션 도메인 릴레이 — domain_bridge 가 액션(actions:)을 지원하지 않아 이를 대체한다.

배경:
  설치된 domain_bridge(jazzy 0.5.0)는 topic 만 중계하고 actions:/services: 섹션은
  조용히 무시한다(라이브러리에 action 브릿지 심볼이 아예 없음, upstream issue #11 미구현).
  그래서 rosbridge(허브 49)의 /ramp_control 액션 goal 이 로봇(40)의 실서버까지 도달하지 못했다.

동작:
  한 프로세스 안에서 도메인별 rclpy Context 를 따로 띄우고,
    - 허브 도메인(49): 액션 '서버' 를 연다  → rosbridge 의 액션 클라이언트가 여기에 붙는다.
    - 로봇 도메인(40): 액션 '클라이언트' 로 실서버(/ramp_controller)에 붙는다.
  goal / feedback / result / cancel 을 그대로 양방향 중계한다. (domain_bridge 가 topic 에 대해
  하는 일을, 액션에 대해 대신 해주는 얇은 프록시)

실행:
  start_domain_bridge.sh 가 domain_bridge 와 함께 백그라운드로 띄운다.
  domain_bridge 와 '동일한' 환경이 필요하다:
    - 워크스페이스 source (vicpinky_carrier_interfaces 임포트용)
    - FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_unicast.xml (로봇 40 을 유니캐스트로 디스커버리)
  도메인 49(로컬 rosbridge)는 same-host SHM 으로, 도메인 40(원격 로봇)은 유니캐스트 peer 로 발견된다
  — domain_bridge 가 이미 같은 방식으로 40↔49 를 중계하고 있으므로 동일하게 성립한다.
"""

import threading
import time

import rclpy
from rclpy.action import ActionClient, ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor

from action_msgs.msg import GoalStatus

from vicpinky_carrier_interfaces.action import RampControl


# 중계할 액션 목록 — domain_bridge_vicpinky.yaml 의 (동작하지 않는) actions: 섹션을 대체한다.
#   marker_trace 등 액션을 추가하려면 여기에 항목을 한 줄 더 넣기만 하면 된다.
#   hub_domain : 릴레이가 '서버'를 여는 쪽(허브, rosbridge 클라이언트가 붙는 곳)
#   robot_domain: 릴레이가 '클라이언트'로 붙는 쪽(로봇 실서버가 있는 곳)
RELAYS = [
    {
        'action': '/ramp_control',
        'type': RampControl,
        'hub_domain': 49,
        'robot_domain': 40,
    },
    # {'action': '/marker_trace', 'type': MarkerTrace, 'hub_domain': 49, 'robot_domain': 40},
]

# 로봇측 실서버가 뜰 때까지 기다리는 최대 시간(초). 초과하면 goal 을 abort.
SERVER_WAIT_SEC = 5.0


class ActionRelay:
    """액션 하나를 허브(server)↔로봇(client)로 중계."""

    def __init__(self, spec, hub_node, robot_node):
        self.name = spec['action']
        self.action_type = spec['type']
        self.log = hub_node.get_logger()

        # 로봇 도메인(40): 실서버로 goal 을 보내는 클라이언트
        self._client = ActionClient(
            robot_node, self.action_type, self.name,
            callback_group=ReentrantCallbackGroup(),
        )

        # 허브 도메인(49): rosbridge 가 붙는 서버.
        #   execute 가 결과를 기다리며 블로킹하므로 취소가 동시에 처리되도록 Reentrant 그룹 + 멀티스레드 executor 사용.
        self._server = ActionServer(
            hub_node, self.action_type, self.name,
            execute_callback=self._execute,
            goal_callback=lambda goal_request: GoalResponse.ACCEPT,
            cancel_callback=lambda goal_handle: CancelResponse.ACCEPT,
            callback_group=ReentrantCallbackGroup(),
        )
        self.log.info(f'릴레이 준비: {self.name}  (허브 서버 ↔ 로봇 클라이언트)')

    def _execute(self, hub_goal_handle):
        """허브에서 받은 goal 을 로봇으로 전달하고 feedback/result 를 되돌린다."""
        request = hub_goal_handle.request
        result_cls = self.action_type.Result

        if not self._client.wait_for_server(timeout_sec=SERVER_WAIT_SEC):
            self.log.warn(f'{self.name}: 로봇측 서버 없음 → abort')
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
                self.log.info(f'{self.name}: 취소 요청 → 로봇으로 전파')
                box['robot_gh'].cancel_goal_async()

        if box.get('rejected'):
            self.log.warn(f'{self.name}: 로봇측이 goal 거부 → abort')
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
            self.log.error(f'{self.name}: 종료 상태 설정 실패: {exc!r}')
        return wrapped.result


def main():
    # 사용되는 모든 도메인에 대해 컨텍스트/노드/executor 를 하나씩 준비한다.
    domains = set()
    for spec in RELAYS:
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

    relays = [
        ActionRelay(spec, nodes[spec['hub_domain']], nodes[spec['robot_domain']])
        for spec in RELAYS
    ]

    # 각 도메인 executor 를 별도 스레드에서 spin.
    for executor in executors.values():
        t = threading.Thread(target=executor.spin, daemon=True)
        t.start()
        threads.append(t)

    log = next(iter(nodes.values())).get_logger()
    log.info(f'액션 릴레이 시작 — {len(relays)}개 액션, 도메인 {sorted(domains)}')

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
