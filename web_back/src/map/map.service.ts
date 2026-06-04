import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RosService } from '../ros/ros.service';
import * as zlib from 'zlib';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
      const m = msg.topic.match(/^\/([^/]+)\/map$/);
      if (!m) return;
      const botId = m[1];
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

  // ── 맵 캐시 삭제 + Cartographer 재시작 ───────────────────────────────────

  clearMap(botId: string) {
    this.maps.delete(botId);
    this.clearCbs.forEach((cb) => cb(botId));
  }

  async resetMap(botId: string): Promise<{ ok: boolean; message: string }> {
    // 1. 캐시 즉시 삭제 → 프론트 화면 비움
    this.clearMap(botId);

    const setup    = process.env.ROS2_SETUP         ?? '/opt/ros/humble/setup.bash';
    const cfgDir   = process.env.CARTOGRAPHER_CONFIG_DIR  ?? '';
    const cfgFile  = process.env.CARTOGRAPHER_CONFIG_FILE ?? 'turtlebot3_lds_2d.lua';
    const shell    = { shell: '/bin/bash' as const, timeout: 10_000 };

    try {
      // 2. 현재 trajectory 종료
      await execAsync(
        `source ${setup} && ros2 service call /${botId}/cartographer_node/finish_trajectory ` +
        `cartographer_ros_msgs/srv/FinishTrajectory "{trajectory_id: 0}"`,
        shell,
      );
      this.logger.log(`[${botId}] finish_trajectory 완료`);

      await new Promise((r) => setTimeout(r, 400));

      // 3. 새 trajectory 시작 (config 경로가 설정된 경우)
      if (cfgDir) {
        await execAsync(
          `source ${setup} && ros2 service call /${botId}/cartographer_node/start_trajectory ` +
          `cartographer_ros_msgs/srv/StartTrajectory ` +
          `"{configuration_directory: '${cfgDir}', configuration_basename: '${cfgFile}', ` +
          `use_initial_pose: false, relative_to_trajectory_id: 0}"`,
          shell,
        );
        this.logger.log(`[${botId}] start_trajectory 완료`);
      }

      return { ok: true, message: '초기화 완료' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${botId}] 맵 초기화 실패: ${msg}`);
      return { ok: false, message: msg };
    }
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
