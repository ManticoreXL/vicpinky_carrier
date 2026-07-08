// 로봇 로스터(고정 명단) — 도메인 ID·도메인번호·종류. 여러 화면이 "표시 순회"용으로 공유한다.
// 실시간 상태·배터리·위치는 백엔드 소켓이 단일 출처다. 이 목록은 "어떤 로봇이 존재하는가"의 정적 명단일 뿐.
// (이전에 views/taskmanager/constants.ts 와 views/FmsView.tsx 에 중복돼 있던 것을 통합.)
export const ROBOTS = [
  { id: "vicpinky", domain: 40, type: "carrier" },
  { id: "tb3_01",   domain: 41, type: "tb3" },
  { id: "tb3_02",   domain: 42, type: "tb3" },
  { id: "tb3_03",   domain: 43, type: "tb3" },
  { id: "tb3_04",   domain: 44, type: "tb3" },
  { id: "omx",      domain: 45, type: "arm" },
  // rosbridge 미경유 가상 테스트봇 4대 (항상 성공)
  { id: "TEST-BOT1", domain: 99,  type: "test" },
  { id: "TEST-BOT2", domain: 100, type: "test" },
  { id: "TEST-BOT3", domain: 101, type: "test" },
  { id: "TEST-BOT4", domain: 102, type: "test" },
] as const;

// 가상 테스트봇 판별 — 운영 화면 표시에서만 숨기는 용도.
// 백엔드 소켓으로 받는 실시간 목록(RobotInfo)엔 type 필드가 없어, id 패턴으로 단일 판별한다.
export const isTestBot = (id: string): boolean => /^TEST-?BOT/i.test(id);

// 운영 화면 표시용 로스터 — 테스트봇 제외.
// (적합도 탭·큐테스트·빌더 등 테스트 전용 화면은 ROBOTS 원본을 그대로 사용한다.)
export const OPERATIONAL_ROBOTS = ROBOTS.filter((r) => !isTestBot(r.id));

// 가상 테스트봇 ID 목록 — 헤더 토글 ON 시 운영 화면(정찰 등)에 끼워 넣을 때 사용.
export const TEST_BOT_IDS = ROBOTS.filter((r) => isTestBot(r.id)).map((r) => r.id);
