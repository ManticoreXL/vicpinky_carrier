import { Controller, Post, UseInterceptors, UploadedFile, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AiService } from './ai.service';
import { AgentService } from './agent.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService:    AiService,
    private readonly agentService: AgentService,
  ) {}

  @Post('stt')
  @UseInterceptors(FileInterceptor('file'))
  async transcribe(@UploadedFile() file: Express.Multer.File) {
    return this.aiService.transcribe(file);
  }

  @Post('ask')
  async ask(@Body('text') text: string) {
    const response = await this.aiService.ask(text);
    return { response };
  }

  /**
   * EXAONE 에이전트: 자연어 명령 → 툴 호출 → 자율 실행
   * Body: { text: string }
   * Returns: { reply: string, actions: AgentAction[] }
   */
  @Post('agent')
  async agent(@Body('text') text: string) {
    return this.agentService.run(text);
  }
}
