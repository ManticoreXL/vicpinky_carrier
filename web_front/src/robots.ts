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
