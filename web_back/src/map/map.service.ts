import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros/ros.service';
import * as zlib from 'zlib';

// ── 타입 ─────────────────────────────────────────────────────────────────────

export interface MapInfo {
  resolution: number;
  width: number;
  height: number;
  origin: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
}

interface StoredMap {
  info: MapInfo;
  data: number[];
  pngCache: Buffer;
  timestamp: number;
}

// ── 서비스 ────────────────────────────────────────────────────────────────────

@Injectable()
export class MapService implements OnModuleInit {
  private readonly logger = new Logger(MapService.name);
  private readonly maps = new Map<string, StoredMap>();
  private readonly updateCbs: ((botId: string, info: MapInfo) => void)[] = [];
  private readonly clearCbs: ((botId: string) => void)[] = [];

  constructor(private readonly rosService: RosService) {}

  onModuleInit() {
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
}
