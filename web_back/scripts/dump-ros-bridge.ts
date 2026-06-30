#!/usr/bin/env ts-node
/**
 * domain_bridge 설정을 파싱해 "허브(rosbridge)에서 각 로봇을 제어/관측할 때
 * 실제 사용해야 하는 ROS 토픽·타입"을 출력하는 독립 실행 스크립트.
 *
 * 이 스크립트가 만드는 결과를 백엔드(DomainBridgeService)와 LLM(EXAONE)이 동일하게 참조한다.
 *
 * 사용법:
 *   npm run ros:bridge                      # 사람이 읽는 요약
 *   npm run ros:bridge -- --json            # JSON 출력 (파이프라인용)
 *   DOMAIN_BRIDGE_DIR=/path npm run ros:bridge
 */
import * as path from 'path';
import { parseBridgeDir, summarizeBridgeMap } from '../src/ros/domain-bridge/domain-bridge.parser';

const dir =
  process.env.DOMAIN_BRIDGE_DIR ??
  path.resolve(__dirname, '..', '..', 'ros_packages', 'domain_bridge');

const map = parseBridgeDir(dir);

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(map, null, 2) + '\n');
} else {
  console.log(`# domain_bridge dir: ${dir}\n`);
  console.log(summarizeBridgeMap(map));
}

if (map.robots.length === 0) {
  console.error(`\n[경고] domain_bridge_*.yaml 파일을 찾지 못했습니다: ${dir}`);
  process.exit(1);
}
