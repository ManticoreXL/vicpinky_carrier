import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

// .env 로드 (Node 20.6+ / 23). 파일 없으면 무시하고 기본값 사용.
try {
  process.loadEnvFile();
} catch {
  /* .env 없음 — 코드 기본값 사용 */
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // DEBUG / VERBOSE 제외 — 연결·경고·에러만 출력
    logger: ['log', 'warn', 'error'],
  });
  app.enableCors({ origin: '*' });
  // 비전 분석용 base64 이미지 수용 — 본문 한도 상향
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ limit: '15mb', extended: true }));
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`NestJS 백엔드 실행 중: http://localhost:${port}`);
}
bootstrap();
