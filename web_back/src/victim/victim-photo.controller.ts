import { Controller, Get, Post, Delete, Param, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { VictimPhotoService } from './victim-photo.service';

@Controller('api/victim')
export class VictimPhotoController {
  constructor(private readonly photos: VictimPhotoService) {}

  /** 받아온 조난자 사진 목록 (좌표·시각·이미지 URL 포함) */
  @Get('photos')
  list() {
    return this.photos.list().map((p) => ({
      ...p,
      url: `/api/victim/photo/${encodeURIComponent(p.file)}`,
    }));
  }

  /** 로봇 maps 폴더에서 새 사진 즉시 동기화 (수동 트리거) */
  @Post('photos/sync')
  sync() {
    return this.photos.sync();
  }

  /** 받아온 조난자 사진 전체 초기화 (로컬 삭제 + 재동기화 방지. 로봇 원본은 보존) */
  @Delete('photos')
  clear() {
    return this.photos.clear();
  }

  /** 사진 이미지 서빙 (jpeg) */
  @Get('photo/:file')
  getPhoto(@Param('file') file: string, @Res() res: Response) {
    res.set('Access-Control-Allow-Origin', '*');
    // path-traversal 방지 — 단일 파일명만 허용
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      return res.status(HttpStatus.BAD_REQUEST).send('bad name');
    }
    const p = this.photos.localPath(file);
    if (!fs.existsSync(p)) return res.status(HttpStatus.NOT_FOUND).send('no photo');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.sendFile(p);
  }
}
