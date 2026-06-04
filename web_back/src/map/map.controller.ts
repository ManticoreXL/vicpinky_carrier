import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
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
