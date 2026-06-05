import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // DEBUG / VERBOSE 제외 — 연결·경고·에러만 출력
    logger: ['log', 'warn', 'error'],
  });
  app.enableCors({ origin: '*' });
  await app.listen(3001);
  console.log('NestJS 백엔드 실행 중: http://localhost:3001');
}
bootstrap();
