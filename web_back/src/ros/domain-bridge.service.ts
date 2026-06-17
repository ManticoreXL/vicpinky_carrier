import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import {
  parseBridgeDir,
  summarizeBridgeMap,
  type BridgeMap,
  type RobotCapabilities,
} from './domain-bridge.parser';

// 기본 위치: <repo>/ros_packages/domain_bridge
// web_back 에서 실행되므로 한 단계 위로 올라가 ros_packages 를 찾는다.
const DEFAULT_DIR = path.resolve(process.cwd(), '..', 'ros_packages', 'domain_bridge');

// ──────────────────────────────────────────────────────────────────────────────
// domain_bridge 설정을 부팅 시 1회 로드해 메모리에 캐시한다.
// LLM(AgentService)과 RAG가 "실제 제어 가능한 ROS 토픽/타입"을 참조하는 단일 소스.
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DomainBridgeService implements OnModuleInit {
  private readonly logger = new Logger(DomainBridgeService.name);
  private readonly dir = process.env.DOMAIN_BRIDGE_DIR ?? DEFAULT_DIR;
  private map: BridgeMap = { hubDomain: null, robots: [], generatedAt: new Date(0).toISOString() };

  onModuleInit() {
    this.reload();
  }

  /** YAML을 다시 읽어 캐시 갱신 (설정 변경 시 호출 가능) */
  reload(): BridgeMap {
    try {
      this.map = parseBridgeDir(this.dir);
      const robotIds = this.map.robots.map((r) => r.robotId).join(', ');
      this.logger.log(
        `domain_bridge 로드 완료 — 허브 도메인 ${this.map.hubDomain ?? '?'}, 로봇 [${robotIds || '없음'}] (${this.dir})`,
      );
    } catch (e) {
      this.logger.warn(`domain_bridge 로드 실패 (${this.dir}): ${String(e)}`);
    }
    return this.map;
  }

  getMap(): BridgeMap {
    return this.map;
  }

  /** 특정 로봇의 제어/관측 가능 토픽. robotId 미지정 시 전체 */
  getCapabilities(robotId?: string): RobotCapabilities | RobotCapabilities[] | null {
    if (!robotId) return this.map.robots;
    return this.map.robots.find((r) => r.robotId === robotId) ?? null;
  }

  /** LLM 시스템 프롬프트 / 사람용 요약 텍스트 */
  getSummary(): string {
    return summarizeBridgeMap(this.map);
  }
}
