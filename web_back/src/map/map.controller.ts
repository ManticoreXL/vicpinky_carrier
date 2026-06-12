import { Controller, Get, Post, Param, Body, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { MapService } from './map.service';

@Controller('api/map')
export class MapController {
  constructor(private readonly mapService: MapService) {}

  /** 미리 렌더링된 PNG 이미지 반환 */
  @Get(':botId/image')
  getImage(@Param('botId') botId: string, @Res() res: Response) {
    const png = this.mapService.getPng(botId);
    if (!png) return res.status(HttpStatus.NOT_FOUND).send('no map');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(png);
  }

  /** nav2 호환 PGM 다운로드 */
  @Get(':botId/pgm')
  getPgm(@Param('botId') botId: string, @Res() res: Response) {
    const pgm = this.mapService.getPgm(botId);
    if (!pgm) return res.status(HttpStatus.NOT_FOUND).send('no map');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${botId}_map.pgm"`);
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(pgm);
  }

  /** Cartographer 초기화 — 캐시 삭제 + finish/start trajectory */
  @Post(':botId/reset')
  async resetMap(@Param('botId') botId: string, @Res() res: Response) {
    const result = await this.mapService.resetMap(botId);
    res.set('Access-Control-Allow-Origin', '*');
    return res.status(result.ok ? HttpStatus.OK : HttpStatus.INTERNAL_SERVER_ERROR).json(result);
  }

  /** 사용 가능한 정적 맵 목록 */
  @Get('static/list')
  getStaticList(@Res() res: Response) {
    res.set('Access-Control-Allow-Origin', '*');
    return res.json(this.mapService.listStaticMaps());
  }

  /** 로봇별 현재 맵 할당 목록 */
  @Get('assignments')
  getAssignments(@Res() res: Response) {
    res.set('Access-Control-Allow-Origin', '*');
    return res.json(this.mapService.getAssignments());
  }

  /** 로봇에 맵 할당 + nav2 load_map 서비스 호출 */
  @Post('assign')
  async assignMap(
    @Body() body: { robotId: string; mapName: string },
    @Res() res: Response,
  ) {
    const result = await this.mapService.assignMap(body.robotId, body.mapName);
    res.set('Access-Control-Allow-Origin', '*');
    return res.status(result.ok ? HttpStatus.OK : HttpStatus.INTERNAL_SERVER_ERROR).json(result);
  }

  /** 정적 PGM 맵 → PNG 이미지 */
  @Get('static/:name/image')
  getStaticImage(@Param('name') name: string, @Res() res: Response) {
    const result = this.mapService.loadStaticMap(name);
    if (!result) return res.status(HttpStatus.NOT_FOUND).send('map not found');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(result.png);
  }

  /** 정적 맵 메타데이터 (resolution, origin, size) */
  @Get('static/:name/info')
  getStaticInfo(@Param('name') name: string, @Res() res: Response) {
    const result = this.mapService.loadStaticMap(name);
    if (!result) return res.status(HttpStatus.NOT_FOUND).json({ error: 'not found' });
    res.set('Access-Control-Allow-Origin', '*');
    return res.json(result.info);
  }

  /** nav2 호환 YAML 다운로드 */
  @Get(':botId/yaml')
  getYaml(@Param('botId') botId: string, @Res() res: Response) {
    const yaml = this.mapService.getYaml(botId, `${botId}_map.pgm`);
    if (!yaml) return res.status(HttpStatus.NOT_FOUND).send('no map');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${botId}_map.yaml"`);
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(yaml);
  }
}
