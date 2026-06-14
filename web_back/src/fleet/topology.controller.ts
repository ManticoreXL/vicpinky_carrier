import { Controller, Get, Post, Patch, Delete, Param, Body, Query, HttpCode } from '@nestjs/common';
import { TopologyService } from './topology.service';
import { Node, NodeType } from './node.schema';
import { Edge } from './edge.schema';

@Controller('api/fleet/topology')
export class TopologyController {
  constructor(private readonly topologyService: TopologyService) {}

  // ── Nodes ────────────────────────────────────────────────────────────────

  @Get('nodes')
  findNodes(@Query('map_id') map_id?: string) {
    return this.topologyService.findAllNodes(map_id);
  }

  // static 경로는 반드시 동적 경로(:id)보다 먼저 선언해야 충돌이 없다
  @Get('nodes/by-type/:map_id/:type')
  findByType(@Param('map_id') map_id: string, @Param('type') type: NodeType) {
    return this.topologyService.findNodesByType(map_id, type);
  }

  @Get('nodes/:id')
  findNode(@Param('id') id: string) { return this.topologyService.findNodeById(id); }

  @Post('nodes')
  createNode(@Body() dto: Partial<Node>) { return this.topologyService.createNode(dto); }

  @Patch('nodes/:id')
  updateNode(@Param('id') id: string, @Body() dto: Partial<Node>) {
    return this.topologyService.updateNode(id, dto);
  }

  @Delete('nodes/:id')
  @HttpCode(204)
  removeNode(@Param('id') id: string) { return this.topologyService.removeNode(id); }

  // ── Edges ────────────────────────────────────────────────────────────────

  @Get('edges')
  findEdges(@Query('map_id') map_id?: string) {
    return this.topologyService.findAllEdges(map_id);
  }

  @Get('edges/:id')
  findEdge(@Param('id') id: string) { return this.topologyService.findEdgeById(id); }

  @Post('edges')
  createEdge(@Body() dto: Partial<Edge>) { return this.topologyService.createEdge(dto); }

  @Patch('edges/:id')
  updateEdge(@Param('id') id: string, @Body() dto: Partial<Edge>) {
    return this.topologyService.updateEdge(id, dto);
  }

  @Delete('edges/:id')
  @HttpCode(204)
  removeEdge(@Param('id') id: string) { return this.topologyService.removeEdge(id); }

  @Patch('edges/:id/lock')
  lockEdge(@Param('id') id: string, @Body('isLocked') isLocked: boolean) {
    return this.topologyService.setLocked(id, isLocked);
  }

  // ── 경로 탐색 ──────────────────────────────────────────────────────────────

  @Get('path')
  findPath(
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('map_id') map_id: string,
  ) {
    return this.topologyService.findPath(start, end, map_id);
  }
}
