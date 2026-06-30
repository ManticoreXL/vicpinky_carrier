import { Controller, Get, Post, Delete, Param, Body, Query } from '@nestjs/common';
import { TaskRepositoryService } from './task-repository.service';
import { TaskStatusService } from './task-status.service';
import type { CreateTaskDto } from './task.dto';
import { TaskManagerService } from './task-manager.service';
import { AutoTaskService } from './auto-task.service';

@Controller('api/fms')
export class FmsController {
  constructor(
    private readonly taskRepo: TaskRepositoryService,
    private readonly taskStatus: TaskStatusService,
    private readonly taskManager: TaskManagerService,
    private readonly autoTask: AutoTaskService,
  ) {}

  @Get('tasks')
  list(
    @Query('status')   status?:   string,
    @Query('robot_id') robot_id?: string,
    @Query('limit')    limit?:    string,
    @Query('sort')     sort?:     string, // 'priority' | 'recent'(기본)
    @Query('afterMs')  afterMs?:  string, // 기준 시각(epoch ms) 이후 등록만
  ) {
    return this.taskRepo.list({
      status,
      robot_id,
      limit: limit ? +limit : undefined,
      sort: sort === 'priority' ? 'priority' : 'recent',
      afterMs: afterMs ? +afterMs : undefined,
    });
  }

  @Get('tasks/:id')
  getOne(@Param('id') id: string) {
    return this.taskRepo.getTask(id);
  }

  /** ★ 주어진 태스크에 대한 로봇 우선순위(적합도) 랭킹 — 글로벌 태스크 큐가 robot-priority.ts로 계산. */
  @Get('tasks/:id/robot-ranking')
  robotRanking(@Param('id') id: string) {
    return this.taskManager.rankRobotsForTask(id);
  }

  /** ★ 목적지(+유형) 기준 로봇 추천 — 새 태스크 등록 중 드롭다운 펼칠 때 매번 호출. */
  @Get('robot-ranking')
  robotRankingForTarget(@Query('targetNode') targetNode: string, @Query('type') type?: string) {
    return this.taskManager.rankRobotsForTarget(targetNode ?? '', type);
  }

  @Post('tasks')
  create(@Body() dto: CreateTaskDto) {
    // 로봇 미지정(draft) → DRAFT(등록만, 할당 불가) / 로봇 지정 → PENDING(할당 대기). 자동 실행은 없음.
    return dto.draft ? this.taskManager.register(dto) : this.taskManager.enqueue(dto);
  }

  /** 연속 등록·실행 — 한 로봇에게 여러 태스크를 seq 순서로 생성하고 첫 태스크부터 순차 실행. repeat=true면 반복. */
  @Post('tasks/batch')
  createBatch(@Body() body: { preferredRobotId: string; tasks: CreateTaskDto[]; repeat?: boolean }) {
    return this.taskManager.enqueueBatch(body.preferredRobotId, body.tasks ?? [], body.repeat ?? false);
  }

  /** 시나리오 등록·실행 — 단건 태스크들(로봇 다를 수 있음)을 seq 순서로 생성하고 한 스텝씩 순차 실행. */
  @Post('tasks/scenario')
  createScenario(@Body() body: { steps: CreateTaskDto[] }) {
    return this.taskManager.enqueueScenario(body.steps ?? []);
  }

  /** 저장된 커스텀 시나리오(TaskSequence) 실행 — 정의들을 인스턴스화해 seq 순서로 순차 실행. */
  @Post('sequences/:id/run')
  runSequence(@Param('id') id: string) {
    return this.taskManager.runSequence(id);
  }

  /** 단일 태스크(Task 정의) 실행/테스트 — 정의를 실행 레코드 하나로 인스턴스화해 dispatch. robotId/targetNode 는 실행 파라미터(옵션). */
  @Post('task-defs/:id/run')
  runTaskDef(@Param('id') id: string, @Body() body: { robotId?: string; targetNode?: string }) {
    return this.taskManager.runTaskDef(id, { robotId: body?.robotId ?? null, targetNode: body?.targetNode });
  }

  /** 반복 연속 정지 — 반복 해제 + 비종료 태스크 COMPLETED 처리로 로봇 큐 종료. */
  @Post('tasks/batch/:batchId/stop')
  stopBatch(@Param('batchId') batchId: string) {
    return this.taskManager.stopBatch(batchId);
  }

  /** 태스크 1건을 수동 할당. body.robotId가 오면 그 로봇을 지정(+DRAFT→PENDING)한 뒤 실행. */
  @Post('tasks/:id/dispatch')
  async dispatch(@Param('id') id: string, @Body() body?: { robotId?: string }) {
    if (body?.robotId) await this.taskStatus.prepareForDispatch(id, body.robotId);
    return this.taskManager.dispatchTask(id);
  }

  @Delete('tasks/:id/cancel')
  async cancel(@Param('id') id: string) {
    await this.taskManager.cancelTask(id);
    return { ok: true };
  }

  /** 일시정지로 보류된 태스크 재개 — 들고 있던 큐를 그 지점부터 계속 수행. */
  @Post('tasks/:id/resume')
  async resume(@Param('id') id: string) {
    return this.taskManager.resumeTask(id);
  }

  @Delete('tasks/:id')
  async remove(@Param('id') id: string) {
    await this.taskRepo.remove(id);
    return { ok: true };
  }

  /** 글로벌 태스크 큐 초기화 — 미배정 대기(PENDING/DRAFT) 일괄 삭제 */
  @Delete('queue')
  async clearQueue() {
    const removed = await this.taskManager.clearGlobalQueue();
    return { ok: true, removed };
  }

  /** 전체 태스크 초기화 — fms_tasks 전부 삭제 (새로 시작용) */
  @Delete('tasks')
  async wipeAll() {
    const removed = await this.taskManager.wipeAllTasks();
    return { ok: true, removed };
  }

  // ── 자동 디스패처 (on/off) — 미배정 태스크를 우선순위순으로 최우선 가용 로봇에 자동 할당 ──
  @Get('auto-dispatch')
  getAutoDispatch() {
    return { enabled: this.taskManager.isAutoDispatch() };
  }

  @Post('auto-dispatch')
  setAutoDispatch(@Body() body: { enabled: boolean }) {
    this.taskManager.setAutoDispatch(!!body?.enabled);
    return { enabled: this.taskManager.isAutoDispatch() };
  }

  // ── 자동 충전 on/off — 충전 필요 로봇을 빈 충전소(가까운 순)로, 없으면 초기위치 대기 ──
  @Get('auto-charge')
  getAutoCharge() {
    return { enabled: this.taskManager.isAutoCharge() };
  }

  @Post('auto-charge')
  setAutoCharge(@Body() body: { enabled: boolean }) {
    this.taskManager.setAutoCharge(!!body?.enabled);
    return { enabled: this.taskManager.isAutoCharge() };
  }

  // ── ROS 데이터 기준 태스크 자동 생성 (규칙 엔진) on/off ──
  @Get('auto-task')
  getAutoTask() {
    return { enabled: this.autoTask.isEnabled(), rules: this.autoTask.listRules() };
  }

  @Post('auto-task')
  setAutoTask(@Body() body: { enabled: boolean }) {
    this.autoTask.setEnabled(!!body?.enabled);
    return { enabled: this.autoTask.isEnabled(), rules: this.autoTask.listRules() };
  }
}
// AI 태스크 생성/대화는 AiController(/ai/agent 등)가 담당 — FMS는 AI에 의존하지 않는다.
