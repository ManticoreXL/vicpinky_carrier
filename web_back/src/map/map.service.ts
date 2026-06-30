import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros/ros.service';
import { CoreEventBus, CoreEvent } from '../core-events/core-events.service';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface StaticMapInfo {
  resolution: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  snapThreshold?: number;
}

export interface MapInfo {
  resolution: number;
  width: number;
  height: number;
  origin: { 
    position: { x: number; y: number; z: number },
    orientation: { x: number; y: number; z: number; w: number } 
  };
  snapThreshold?: number;
}

interface StoredMap {
  info: MapInfo;
  data: number[];
  pngCache: Buffer;
  timestamp: number;
}

const MAPS_DIR = process.env.MAPS_DIR ?? '/home/js/map';
const ASSIGNMENTS_FILE = path.join(MAPS_DIR, 'assignments.json');

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class MapService implements OnModuleInit {
  private readonly logger = new Logger(MapService.name);
  private readonly maps = new Map<string, StoredMap>();
  private readonly updateCbs: ((botId: string, info: MapInfo) => void)[] = [];
  private readonly clearCbs: ((botId: string) => void)[] = [];

  // robotId → mapName
  private readonly robotAssignments = new Map<string, string>();

  // 맵 스트림 on/off — OFF면 들어오는 /map(slam) 메시지의 처리/전송(buildPng+브로드캐스트)을 스킵한다.
  // (라이브 갱신만 멈춤 — 마지막으로 캐시된 맵은 그대로 유지/표시. 기본 ON)
  private mapStream = true;

  constructor(
    private readonly rosService: RosService,
    private readonly bus: CoreEventBus,
  ) {}

  onModuleInit() {
    this.loadAssignments();
    // 정적 맵 사전 캐시 — 첫 클라이언트 접속 시 지연 없애기
    setImmediate(() => {
      const maps = this.listStaticMaps();
      this.logger.log(`[맵 캐시] 정적 맵 ${maps.length}개 사전 로드 시작`);
      for (const name of maps) {
        try { this.loadStaticMap(name); } catch { /* ignore */ }
      }
      this.logger.log(`[맵 캐시] 사전 로드 완료`);
    });
    this.rosService.onMessage((msg) => {
      // 글로벌 /map (project_slam / slam_toolbox) → 'project_slam' 키
      // 네임스페이스 맵 /{botId}/map → 해당 botId 키
      let botId: string;
      if (msg.topic === '/map') {
        botId = 'project_slam';
      } else {
        const m = msg.topic.match(/^\/([^/]+)\/map$/);
        if (!m) return;
        botId = m[1];
      }
      if (!this.mapStream) return; // 맵 스트림 OFF — 무거운 buildPng/브로드캐스트 스킵(마지막 캐시 유지)
      const raw = msg.data as { info?: MapInfo; data?: number[] };
      if (!raw?.info || !raw?.data?.length) return;

      const pngCache = this.buildPng(raw.info, raw.data);
      this.maps.set(botId, {
        info: raw.info,
        data: raw.data,
        pngCache,
        timestamp: msg.timestamp,
      });
      this.updateCbs.forEach((cb) => cb(botId, raw.info!));
    });
  }

  onUpdate(cb: (botId: string, info: MapInfo) => void) {
    this.updateCbs.push(cb);
  }

  onClear(cb: (botId: string) => void) {
    this.clearCbs.push(cb);
  }

  // ── 맵 스트림 on/off ──────────────────────────────────────────────────────────
  setMapStream(on: boolean): void {
    this.mapStream = on;
    this.logger.log(`[맵 스트림] ${on ? 'ON — /map 수신 처리' : 'OFF — /map 처리/전송 중지(마지막 캐시 유지)'}`);
  }
  isMapStream(): boolean { return this.mapStream; }

  /**
   * 현재 캐시된 맵 메타 목록 (botId, info, timestamp).
   * /map은 latched(transient_local)라 신규 클라이언트 접속 시 라이브 갱신이 없을 수 있어,
   * 게이트웨이가 이 목록으로 초기 상태를 보내 화면이 'MAP NO DATA' 대신 즉시 렌더되게 한다.
   */
  listCachedMaps(): { botId: string; info: MapInfo; timestamp: number }[] {
    return [...this.maps.entries()].map(([botId, s]) => ({
      botId, info: s.info, timestamp: s.timestamp,
    }));
  }

  // ── 맵 캐시 삭제 + slam_toolbox 리셋 ─────────────────────────────────────

  clearMap(botId: string) {
    this.maps.delete(botId);
    this.clearCbs.forEach((cb) => cb(botId));
  }

  /**
   * 맵 초기화. ROS 직접 실행(child_process) 없이 rosbridge로 slam_toolbox
   * reset 서비스를 호출 → 백엔드는 순수 rosbridge 클라이언트(구독+서비스).
   */
  async resetMap(botId: string): Promise<{ ok: boolean; message: string }> {
    // 1. 캐시 즉시 삭제 → 프론트 화면 비움
    this.clearMap(botId);

    // 2. slam_toolbox reset 서비스 호출 (rosbridge 경유, ROS 소싱 불필요)
    const serviceName = process.env.SLAM_RESET_SERVICE ?? '/slam_toolbox/reset';

    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean, message: string) => {
        if (done) return;
        done = true;
        resolve({ ok, message });
      };

      try {
        this.rosService.callService(
          {
            serviceName,
            serviceType: 'slam_toolbox/srv/Reset',
            request: { pause_new_measurements: false },
          },
          () => {
            this.logger.log(`[${botId}] slam_toolbox reset 완료 (${serviceName})`);
            finish(true, '초기화 완료');
          },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${botId}] 맵 초기화 실패: ${msg}`);
        finish(false, msg);
      }

      // 응답이 없어도 5초 후 종료 (요청은 나갔으니 성공 처리)
      setTimeout(() => finish(true, '초기화 요청 전송됨'), 5000);
    });
  }

  getPng(botId: string): Buffer | null {
    return this.maps.get(botId)?.pngCache ?? null;
  }

  getPgm(botId: string): Buffer | null {
    const s = this.maps.get(botId);
    if (!s) return null;
    return this.buildPgm(s.info, s.data);
  }

  getYaml(botId: string, pgmFilename: string): string | null {
    const s = this.maps.get(botId);
    if (!s) return null;
    const { resolution, origin } = s.info;
    return [
      `image: ${pgmFilename}`,
      `resolution: ${resolution}`,
      `origin: [${origin.position.x.toFixed(6)}, ${origin.position.y.toFixed(6)}, 0.000000]`,
      `negate: 0`,
      `occupied_thresh: 0.65`,
      `free_thresh: 0.196`,
      '',
    ].join('\n');
  }

  /**
   * 라이브(SLAM) 맵을 정적 맵으로 저장 → MAPS_DIR/<name>.pgm + <name>.yaml.
   * 저장 후 listStaticMaps()에 잡혀 Fleet(NavMapCanvas) 정적맵 목록에 노출된다.
   */
  saveStaticMap(botId: string, rawName: string): { ok: boolean; name?: string; message: string } {
    const pgm = this.getPgm(botId);
    if (!pgm) return { ok: false, message: `${botId} 라이브 맵 없음 — 맵 수신 후 저장하세요` };
    // 파일명 정리(영숫자/_/- 만 허용, 경로탈출 방지)
    const name = ((rawName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)) || `${botId}_map`;
    const yaml = this.getYaml(botId, `${name}.pgm`);
    if (!yaml) return { ok: false, message: `${botId} 맵 메타 생성 실패` };
    try {
      if (!fs.existsSync(MAPS_DIR)) fs.mkdirSync(MAPS_DIR, { recursive: true });
      fs.writeFileSync(path.join(MAPS_DIR, `${name}.pgm`), pgm);
      fs.writeFileSync(path.join(MAPS_DIR, `${name}.yaml`), yaml, 'utf8');
      this.staticCache.delete(name); // 덮어쓰기 시 캐시 무효화
      this.logger.log(`[${botId}] 라이브 맵 → 정적 맵 저장: ${name} (${MAPS_DIR})`);
      return { ok: true, name, message: `정적 맵 저장 완료: ${name}` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`정적 맵 저장 실패: ${message}`);
      return { ok: false, message };
    }
  }

  // ── PNG 생성 (순수 Node.js, 외부 패키지 없음) ─────────────────────────────

  private buildPng(info: MapInfo, data: number[]): Buffer {
    const { width, height } = info;

    // 각 행에 filter byte(0) + 픽셀 데이터
    const raw = Buffer.alloc(height * (1 + width));
    for (let row = 0; row < height; row++) {
      raw[row * (1 + width)] = 0; // filter: None
      for (let col = 0; col < width; col++) {
        // ROS: row 0 = 남쪽(bottom), PNG: row 0 = top → 수직 반전
        const val = data[(height - 1 - row) * width + col] ?? -1;
        raw[row * (1 + width) + 1 + col] =
          val < 0
            ? 127 // unknown → 회색
            : Math.round((1 - Math.max(0, Math.min(100, val)) / 100) * 254);
      }
    }

    const compressed = zlib.deflateSync(raw);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth 8
    ihdr[9] = 0; // grayscale

    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
      this.chunk('IHDR', ihdr),
      this.chunk('IDAT', compressed),
      this.chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  // ── PGM 생성 (nav2_map_server 호환) ──────────────────────────────────────

  private buildPgm(info: MapInfo, data: number[]): Buffer {
    const { width, height } = info;
    const header = Buffer.from(
      `P5\n# Generated by SLAM Web Dashboard\n${width} ${height}\n255\n`,
    );
    const pixels = Buffer.alloc(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const val = data[(height - 1 - row) * width + col] ?? -1;
        pixels[row * width + col] =
          val < 0
            ? 205 // unknown → grey (ROS convention)
            : Math.round((1 - Math.max(0, Math.min(100, val)) / 100) * 254);
      }
    }
    return Buffer.concat([header, pixels]);
  }

  // ── PNG 청크 헬퍼 ─────────────────────────────────────────────────────────

  private chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(this.crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  }

  private readonly crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  private crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
      crc = (crc >>> 8) ^ this.crcTable[(crc ^ buf[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ── 정적 PGM 맵 로드 ─────────────────────────────────────────────────────

  private staticCache = new Map<string, { png: Buffer; info: StaticMapInfo }>();

  listStaticMaps(): string[] {
    if (!fs.existsSync(MAPS_DIR)) return [];
    return fs.readdirSync(MAPS_DIR)
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('.') && f !== 'assignments.json')
      .map((f) => f.replace('.yaml', ''))
      .filter((name) => fs.existsSync(path.join(MAPS_DIR, `${name}.pgm`)));
  }

  // ── 로봇별 맵 할당 ────────────────────────────────────────────────────────

  getAssignments(): Record<string, string> {
    return Object.fromEntries(this.robotAssignments);
  }

  async assignMap(robotId: string, mapName: string): Promise<{ ok: boolean; message: string }> {
    this.robotAssignments.set(robotId, mapName);
    this.saveAssignments();
    this.staticCache.delete(mapName);

    // 맵 전환 통지 — FMS가 구독해 진행 태스크 취소 + 위치·캐시 초기화(Map은 FMS를 직접 모름)
    this.bus.emit(CoreEvent.ROBOT_MAP_REASSIGNED, { robotId });

    this.logger.log(`[${robotId}] 맵 할당 → ${mapName} (로봇이 직접 map_server 관리)`);
    return { ok: true, message: '맵 할당 완료' };
  }

  private loadAssignments() {
    try {
      if (fs.existsSync(ASSIGNMENTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf8')) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) this.robotAssignments.set(k, v);
        this.logger.log(`맵 할당 로드: ${JSON.stringify(raw)}`);
      }
    } catch { /* 파일 없거나 파싱 실패 시 무시 */ }
  }

  private saveAssignments() {
    try {
      if (!fs.existsSync(MAPS_DIR)) fs.mkdirSync(MAPS_DIR, { recursive: true });
      fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(Object.fromEntries(this.robotAssignments), null, 2));
    } catch (e) { this.logger.error('할당 저장 실패', e); }
  }

  loadStaticMap(name: string): { png: Buffer; info: StaticMapInfo } | null {
    if (this.staticCache.has(name)) return this.staticCache.get(name)!;

    const pgmPath  = path.join(MAPS_DIR, `${name}.pgm`);
    const yamlPath = path.join(MAPS_DIR, `${name}.yaml`);

    if (!fs.existsSync(pgmPath) || !fs.existsSync(yamlPath)) {
      this.logger.warn(`정적 맵 없음: ${pgmPath}`);
      return null;
    }

    // YAML 파싱 (resolution, origin)
    const yamlText = fs.readFileSync(yamlPath, 'utf8');
    const resolution = parseFloat(yamlText.match(/resolution:\s*([\d.e+\-]+)/)?.[1] ?? '0.05');
    const originMatch = yamlText.match(/origin:\s*\[([-\d.\s,e+\-]+)\]/);
    const originParts = originMatch ? originMatch[1].split(',').map(Number) : [0, 0];
    const [originX, originY] = originParts;
    const snapThreshold = parseFloat(yamlText.match(/snap_threshold:\s*([\d.e+\-]+)/)?.[1] ?? '0.25');

    // PGM P5 파싱
    const pgmBuf = fs.readFileSync(pgmPath);
    const parsed = this.parsePgm(pgmBuf);
    if (!parsed) { this.logger.error(`PGM 파싱 실패: ${pgmPath}`); return null; }

    const { width, height, pixels } = parsed;
    const png = this.buildPngFromPgm(width, height, pixels);
    const info: StaticMapInfo = { resolution, width, height, originX, originY, snapThreshold };

    this.staticCache.set(name, { png, info });
    return { png, info };
  }

  private parsePgm(buf: Buffer): { width: number; height: number; pixels: Buffer } | null {
    let i = 0;
    const tokens: string[] = [];

    while (tokens.length < 4 && i < buf.length) {
      // 공백/개행 스킵
      while (i < buf.length && buf[i] <= 32) i++;
      if (i >= buf.length) break;
      // 주석 스킵
      if (buf[i] === 35) { while (i < buf.length && buf[i] !== 10) i++; continue; }
      // 토큰 읽기
      let tok = '';
      while (i < buf.length && buf[i] > 32) tok += String.fromCharCode(buf[i++]);
      if (tok) tokens.push(tok);
    }

    if (tokens[0] !== 'P5' || tokens.length < 4) return null;
    const width  = parseInt(tokens[1]);
    const height = parseInt(tokens[2]);
    // 헤더 끝 이후 1바이트(개행) 넘기기
    while (i < buf.length && buf[i] !== 10) i++;
    i++;

    return { width, height, pixels: buf.slice(i) };
  }

  private buildPngFromPgm(width: number, height: number, pixels: Buffer): Buffer {
    const raw = Buffer.alloc(height * (1 + width));
    for (let row = 0; row < height; row++) {
      raw[row * (1 + width)] = 0; // filter: None
      for (let col = 0; col < width; col++) {
        raw[row * (1 + width) + 1 + col] = pixels[row * width + col] ?? 205;
      }
    }
    const compressed = zlib.deflateSync(raw);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      this.chunk('IHDR', ihdr),
      this.chunk('IDAT', compressed),
      this.chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
