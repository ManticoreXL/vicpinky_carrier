import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as path from 'path';
import { RosService } from '../ros/ros.service';
import { RobotService } from '../robot/robot.service';

// 조난자 사진 1장의 메타 — 파일명에서 파싱.
//   victim_001_x-3.38_y4.25_20260629_002610.jpg → {num:1, x:-3.38, y:4.25, capturedAt:'2026-06-29 00:26:10'}
export interface VictimPhoto {
  file: string;
  num: number;        // 조난자 번호
  x: number;          // map 프레임 좌표 (m)
  y: number;
  capturedAt: string; // 'YYYY-MM-DD HH:MM:SS'
  ts: number;         // epoch ms (정렬용)
}

// ── 설정 (env 오버라이드, 기본값은 사용자 환경) ──
const SCOUT       = process.env.VICTIM_SCOUT_ROBOT ?? 'tb3_01';   // 사진 호스트(로봇 ip) 조회용
const SSH_HOST    = process.env.ROBOT_SSH_HOST ?? '';             // 비면 로봇 DB의 ip 사용
const SSH_PORT    = Number(process.env.ROBOT_SSH_PORT ?? 22);
const SSH_USER    = process.env.ROBOT_SSH_USER ?? 'ubuntu';
const SSH_PASS    = process.env.ROBOT_SSH_PASSWORD ?? '1234';
const REMOTE_DIR  = process.env.VICTIM_REMOTE_DIR ?? '/home/ubuntu/vicpinky_carrier/src/turtlebot3_explorer/maps';
const LOCAL_DIR   = process.env.VICTIMS_DIR ?? path.resolve(process.cwd(), 'victims');
const POLL_MS     = Number(process.env.VICTIM_PHOTO_POLL_MS ?? 7000); // 자동 주기 동기화(ms). 0이면 off(확정 신호 트리거+수동만)

const FILE_RE = /^victim_(\d+)_x(-?\d+(?:\.\d+)?)_y(-?\d+(?:\.\d+)?)_(\d{8})_(\d{6})\.jpe?g$/i;

/**
 * 조난자 사진 — 정찰 로봇(tb3_01)이 maps 폴더에 저장한 victim_*.jpg 를 SSH로 받아와
 * 백엔드 폴더에 두고, 파일명에서 좌표를 파싱해 프론트(intelligence uplink)에 좌표별로 노출한다.
 *  - /victim/confirmed 수신 시마다 잠시 후 동기화(파일 저장 지연 대응) + 부팅 시 1회 + 수동(POST /sync).
 *  - 새 파일만 내려받는다(이미 로컬에 있으면 skip). 재시작 시 로컬 폴더를 스캔해 복원.
 */
@Injectable()
export class VictimPhotoService implements OnModuleInit {
  private readonly logger = new Logger(VictimPhotoService.name);
  private readonly photos = new Map<string, VictimPhoto>();
  private readonly ignored = new Set<string>(); // clear()로 비운 파일 — 같은 파일 재동기화 방지(세션 한정)
  private syncing = false;
  private debounce: NodeJS.Timeout | null = null;
  private lastFailMsg: string | null = null; // 동일 실패 반복 시 WARN 스팸 억제(첫 1회만 WARN)

  constructor(
    private readonly ros: RosService,
    private readonly robots: RobotService,
  ) {}

  onModuleInit(): void {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    this.scanLocal();
    // 조난자 확정마다 잠시 후 동기화 (로봇이 파일을 저장할 시간을 준다)
    this.ros.onMessage((msg) => {
      if (msg.topic === '/victim/confirmed') this.scheduleSync();
    });
    if (POLL_MS > 0) setInterval(() => void this.sync(), POLL_MS);
    void this.sync(); // 부팅 시 1회
  }

  list(): VictimPhoto[] {
    return [...this.photos.values()].sort((a, b) => a.num - b.num || a.ts - b.ts);
  }
  localPath(file: string): string {
    return path.join(LOCAL_DIR, file);
  }
  private has(file: string): boolean {
    return this.photos.has(file) && fs.existsSync(this.localPath(file));
  }

  /** 받아온 사진 전체 초기화 — 로컬 파일·목록을 비우고, 같은 파일이 재동기화되지 않게 한다(ignored).
   *  로봇 maps 원본은 보존(파괴적 작업 회피) — 영구 초기화하려면 로봇 폴더도 비울 것. */
  clear(): { ok: boolean; cleared: number } {
    const files = [...this.photos.keys()];
    for (const file of files) {
      try { fs.unlinkSync(this.localPath(file)); } catch { /* 이미 없음 */ }
      this.ignored.add(file);
    }
    this.photos.clear();
    this.logger.log(`[victim-photo] 초기화 — 로컬 ${files.length}장 삭제 (로봇 원본 보존)`);
    return { ok: true, cleared: files.length };
  }

  private scheduleSync(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.sync(); }, 2500);
  }

  private scanLocal(): void {
    try {
      for (const f of fs.readdirSync(LOCAL_DIR)) {
        const meta = this.parse(f);
        if (meta) this.photos.set(f, meta);
      }
      if (this.photos.size) this.logger.log(`[victim-photo] 로컬 사진 ${this.photos.size}장 복원 (${LOCAL_DIR})`);
    } catch {
      /* 폴더 비어있음/없음 — 무시 */
    }
  }

  private parse(file: string): VictimPhoto | null {
    const m = FILE_RE.exec(file);
    if (!m) return null;
    const [, numS, xS, yS, dS, tS] = m;
    const Y = +dS.slice(0, 4), Mo = +dS.slice(4, 6), D = +dS.slice(6, 8);
    const H = +tS.slice(0, 2), Mi = +tS.slice(2, 4), S = +tS.slice(4, 6);
    const capturedAt = `${dS.slice(0, 4)}-${dS.slice(4, 6)}-${dS.slice(6, 8)} ${tS.slice(0, 2)}:${tS.slice(2, 4)}:${tS.slice(4, 6)}`;
    return {
      file,
      num: parseInt(numS, 10),
      x: parseFloat(xS),
      y: parseFloat(yS),
      capturedAt,
      ts: new Date(Y, Mo - 1, D, H, Mi, S).getTime(),
    };
  }

  /** 로봇 maps 폴더의 victim_*.jpg 중 새 파일만 SSH로 받아온다. */
  async sync(): Promise<{ ok: boolean; fetched: number; total: number; message?: string }> {
    if (this.syncing) return { ok: true, fetched: 0, total: this.photos.size, message: '이미 동기화 중' };
    this.syncing = true;
    const ssh = new NodeSSH();
    try {
      const { host, online } = await this.resolveTarget();
      if (!host) {
        // 접속 대상 미상 — 조용히 건너뜀(폴링 스팸 방지). 설정은 ROBOT_SSH_HOST(또는 로봇 ip).
        return { ok: false, fetched: 0, total: this.photos.size, message: 'SSH 호스트 미상 — ROBOT_SSH_HOST(또는 로봇 ip) 설정 필요' };
      }
      if (!online) {
        // 정찰 로봇 오프라인 → SSH는 반드시 8초 뒤 handshake 타임아웃. 시도하지 않고 건너뛴다.
        this.logger.debug(`[victim-photo] 정찰 로봇(${SCOUT}) 오프라인 — 사진 동기화 건너뜀`);
        return { ok: false, fetched: 0, total: this.photos.size, message: '정찰 로봇 오프라인 — 동기화 건너뜀' };
      }
      await ssh.connect({ host, port: SSH_PORT, username: SSH_USER, password: SSH_PASS, readyTimeout: 8000 });
      const ls = await ssh.execCommand(`ls -1 ${REMOTE_DIR}/victim_*.jpg 2>/dev/null`);
      const remoteFiles = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      let fetched = 0;
      for (const remotePath of remoteFiles) {
        const file = path.posix.basename(remotePath);
        if (!FILE_RE.test(file) || this.ignored.has(file) || this.has(file)) continue;
        await ssh.getFile(this.localPath(file), remotePath);
        const meta = this.parse(file);
        if (meta) {
          this.photos.set(file, meta);
          fetched++;
          this.logger.log(`[victim-photo] 받음 ${file} → (${meta.x}, ${meta.y})`);
        }
      }
      if (fetched) this.logger.log(`[victim-photo] 동기화 완료 — 새 사진 ${fetched}장 (총 ${this.photos.size})`);
      this.lastFailMsg = null; // 성공 시 경고 재무장(다음 실패는 다시 1회 WARN)
      return { ok: true, fetched, total: this.photos.size };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 로봇 SSH 미기동/포트 차단 등으로 매 폴링(7초)마다 같은 실패가 반복될 수 있다.
      // 첫 발생만 WARN으로 알리고, 동일 메시지 반복은 debug로 낮춰 스팸을 막는다.
      if (message === this.lastFailMsg) this.logger.debug(`[victim-photo] 동기화 실패(반복): ${message}`);
      else this.logger.warn(`[victim-photo] 동기화 실패: ${message}`);
      this.lastFailMsg = message;
      return { ok: false, fetched: 0, total: this.photos.size, message };
    } finally {
      ssh.dispose();
      this.syncing = false;
    }
  }

  // SSH 접속 대상 — env(ROBOT_SSH_HOST) 우선, 없으면 정찰 로봇 DB의 ip.
  //  online: 오프라인 로봇에 대한 무의미한 SSH 시도(→ 8초 handshake 타임아웃)를 막기 위해 함께 반환.
  //  env로 호스트를 명시하면 DB 상태와 무관하게 시도한다(online=true).
  private async resolveTarget(): Promise<{ host: string; online: boolean }> {
    if (SSH_HOST) return { host: SSH_HOST, online: true };
    const r = await this.robots.findById(SCOUT);
    const ip = r?.ip;
    return { host: ip && ip !== 'auto' ? ip : '', online: r?.online !== false };
  }
}
