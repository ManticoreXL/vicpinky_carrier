import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ──────────────────────────────────────────────────────────────────────────────
// domain_bridge YAML 파서 (순수 함수 — Nest 의존성 없음)
//
// ros_packages/domain_bridge/domain_bridge_*.yaml 들을 읽어,
// "허브 도메인(49, rosbridge/백엔드가 보는 곳)에서 각 로봇을 제어/관측하려면
//  어떤 토픽 이름과 메시지 타입을 써야 하는가"를 계산한다.
//
// domain_bridge 규칙:
//   - 최상위 key  = from_domain 에서의 토픽 이름
//   - remap       = to_domain 에서의 토픽 이름
//   - uplink  (robot→hub): to_domain == hub  → 허브 토픽 = remap
//   - downlink (hub→robot): from_domain == hub → 허브 토픽 = key
// ──────────────────────────────────────────────────────────────────────────────

export type BridgeKind = 'topic' | 'action' | 'service';
/** uplink = 로봇→허브(관측/구독), downlink = 허브→로봇(명령/발행) */
export type BridgeDirection = 'uplink' | 'downlink';

export interface BridgeEntry {
  robotId:    string;
  kind:       BridgeKind;
  direction:  BridgeDirection;
  hubTopic:   string; // 허브 도메인에서의 이름 (백엔드/rosbridge가 사용)
  robotTopic: string; // 로봇 도메인에서의 이름
  type:       string; // ROS 메시지/액션 타입
  fromDomain: number;
  toDomain:   number;
}

export interface RobotCapabilities {
  robotId:     string;
  robotDomain: number | null;
  telemetry:   BridgeEntry[]; // uplink — 허브에서 subscribe 가능
  commands:    BridgeEntry[]; // downlink — 허브에서 publish / action goal 가능
}

export interface BridgeMap {
  hubDomain:   number | null;
  robots:      RobotCapabilities[];
  generatedAt: string;
}

interface RawEntry {
  type?:        string;
  from_domain?: number;
  to_domain?:   number;
  remap?:       string;
}

interface RawFile {
  name?:     string;
  topics?:   Record<string, RawEntry>;
  actions?:  Record<string, RawEntry>;
  services?: Record<string, RawEntry>;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function robotIdFromFile(file: string): string {
  return path.basename(file).replace(/^domain_bridge_/, '').replace(/\.ya?ml$/, '');
}

function isValidEntry(e: unknown): e is RawEntry {
  return (
    !!e && typeof e === 'object' &&
    typeof (e as RawEntry).type === 'string' &&
    typeof (e as RawEntry).from_domain === 'number' &&
    typeof (e as RawEntry).to_domain === 'number'
  );
}

/** 디렉터리 안의 domain_bridge_*.yaml 파일 경로 목록 (domain_bridge.yaml 템플릿 제외) */
export function listBridgeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^domain_bridge_.+\.ya?ml$/.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

// ── 파싱 ─────────────────────────────────────────────────────────────────────

export function parseBridgeDir(dir: string): BridgeMap {
  const files = listBridgeFiles(dir);

  // 1차 패스: 파일별 등장 도메인 집합 수집 → 허브 도메인 추론
  //   허브 도메인(49)은 모든 파일에 등장, 로봇 도메인은 파일마다 고유.
  const parsed: { robotId: string; raw: RawFile; domains: Set<number> }[] = [];
  const domainFileCount = new Map<number, number>();

  for (const file of files) {
    let raw: RawFile;
    try {
      raw = (yaml.load(fs.readFileSync(file, 'utf8')) as RawFile) ?? {};
    } catch {
      continue; // 잘못된 YAML은 건너뜀
    }
    const domains = new Set<number>();
    for (const section of [raw.topics, raw.actions, raw.services]) {
      for (const e of Object.values(section ?? {})) {
        if (isValidEntry(e)) {
          domains.add(e.from_domain!);
          domains.add(e.to_domain!);
        }
      }
    }
    for (const d of domains) domainFileCount.set(d, (domainFileCount.get(d) ?? 0) + 1);
    parsed.push({ robotId: robotIdFromFile(file), raw, domains });
  }

  // 가장 많은 파일에 등장한 도메인 = 허브
  let hubDomain: number | null = null;
  let maxCount = 0;
  for (const [d, c] of domainFileCount) {
    if (c > maxCount) { maxCount = c; hubDomain = d; }
  }

  // 2차 패스: 엔트리 빌드
  const robots: RobotCapabilities[] = [];
  for (const { robotId, raw, domains } of parsed) {
    const robotDomain = [...domains].find((d) => d !== hubDomain) ?? null;
    const telemetry: BridgeEntry[] = [];
    const commands:  BridgeEntry[] = [];

    const ingest = (section: Record<string, RawEntry> | undefined, kind: BridgeKind) => {
      for (const [key, e] of Object.entries(section ?? {})) {
        if (!isValidEntry(e)) continue;
        const from = e.from_domain!;
        const to   = e.to_domain!;
        const remap = e.remap ?? key;

        if (to === hubDomain) {
          // uplink: 로봇 → 허브
          telemetry.push({
            robotId, kind, direction: 'uplink',
            hubTopic: remap, robotTopic: key, type: e.type!,
            fromDomain: from, toDomain: to,
          });
        } else if (from === hubDomain) {
          // downlink: 허브 → 로봇
          commands.push({
            robotId, kind, direction: 'downlink',
            hubTopic: key, robotTopic: remap, type: e.type!,
            fromDomain: from, toDomain: to,
          });
        }
      }
    };

    ingest(raw.topics, 'topic');
    ingest(raw.actions, 'action');
    ingest(raw.services, 'service');

    robots.push({ robotId, robotDomain, telemetry, commands });
  }

  return { hubDomain, robots, generatedAt: new Date().toISOString() };
}

// ── LLM/사람용 요약 텍스트 ───────────────────────────────────────────────────

export function summarizeBridgeMap(map: BridgeMap): string {
  if (map.robots.length === 0) return '(domain_bridge 설정을 찾지 못함)';

  const lines: string[] = [
    `=== ROS Domain Bridge 연동 맵 (허브 도메인 ${map.hubDomain ?? '?'}) ===`,
    '아래는 백엔드(rosbridge)가 각 로봇을 제어/관측할 때 실제로 사용해야 하는 토픽과 타입입니다.',
  ];

  for (const r of map.robots) {
    lines.push(`\n[${r.robotId}] (로봇 도메인 ${r.robotDomain ?? '?'})`);

    if (r.commands.length) {
      lines.push('  ▸ 제어(허브→로봇, 발행/액션):');
      for (const c of r.commands) {
        const tag = c.kind === 'action' ? ' [action]' : c.kind === 'service' ? ' [service]' : '';
        lines.push(`    - ${c.hubTopic}  (${c.type})${tag}`);
      }
    }
    if (r.telemetry.length) {
      lines.push('  ▸ 관측(로봇→허브, 구독):');
      for (const t of r.telemetry) {
        lines.push(`    - ${t.hubTopic}  (${t.type})`);
      }
    }
  }

  lines.push('\n주의: 위 hub 토픽 이름/타입이 아니면 domain_bridge가 중계하지 않아 로봇에 도달하지 않습니다.');
  return lines.join('\n');
}
