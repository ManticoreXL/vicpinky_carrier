import { Test } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { TaskType } from '../src/fms/task.schema';
import { TaskCatalogModule } from '../src/task-catalog/task-catalog.module';
import { TaskCatalogService } from '../src/task-catalog/task-catalog.service';

const MONGO = 'mongodb://127.0.0.1:27017/fms_catalog_verify';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TaskCatalog — Task 정의/TaskSequence 저장·로드 (populate)', () => {
  let app: any;
  let catalog: TaskCatalogService;

  jest.setTimeout(60_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(MONGO), TaskCatalogModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const conn = app.get(getConnectionToken()) as Connection;
    await conn.dropDatabase();
    catalog = app.get(TaskCatalogService);
  });

  afterAll(async () => {
    await sleep(200);
    try { await app?.close(); } catch { /* teardown race — 무해 */ }
  });

  it('정의 2개 저장 → 시퀀스로 묶어 저장 → 한꺼번에(populate) 로드', async () => {
    const move = await catalog.createTaskDef({
      name: '구역A 이동', type: TaskType.MOVE, targetNode: 'N3', preferredRobotId: 'tb3_01',
    });
    const deploy = await catalog.createTaskDef({
      name: '전개', type: TaskType.PROCESS,
      steps: [{
        kind: 'service', topicName: '/tb3_02/deploy', messageType: 'turtlebot_state_msgs/srv/Deploy',
        message: { forward_time: 25, forward_speed: 0 }, awaitNodeId: null, awaitKind: 'none', waitMs: 0,
      }] as any,
    });

    // seq 역순으로 넣어도 저장 시 정렬됨
    const seq = await catalog.createSequence({
      name: '정찰+전개 시나리오',
      items: [
        { seq: 2, task: String(deploy._id), robotId: 'tb3_02' },
        { seq: 1, task: String(move._id) },
      ],
    });

    // ── 한꺼번에 로드 (populate) ──
    const loaded = await catalog.getSequence(String(seq._id));
    expect(loaded.items.length).toBe(2);
    expect(loaded.items[0].seq).toBe(1);                              // 저장 시 seq 정렬
    expect((loaded.items[0].task as any).name).toBe('구역A 이동');     // 정의가 통째로 populate
    expect((loaded.items[0].task as any).targetNode).toBe('N3');
    expect((loaded.items[1].task as any).name).toBe('전개');
    expect((loaded.items[1].task as any).steps[0].kind).toBe('service');
    expect((loaded.items[1].task as any).steps[0].message.forward_time).toBe(25);
    expect(loaded.items[1].robotId).toBe('tb3_02');                  // 항목별 로봇 override
  });

  it('목록도 populate 되어 반환되고, 삭제 후 조회는 404', async () => {
    const list = await catalog.listSequences();
    expect(list.length).toBe(1);
    expect((list[0].items[0].task as any).type).toBe(TaskType.MOVE);

    const defs = await catalog.listTaskDefs();
    expect(defs.length).toBe(2);

    const id = String((list[0] as any)._id);
    await catalog.deleteSequence(id);
    await expect(catalog.getSequence(id)).rejects.toThrow();
    expect((await catalog.listSequences()).length).toBe(0);
  });
});
