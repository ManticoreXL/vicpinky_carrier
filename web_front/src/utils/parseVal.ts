// JSON-ish 값 파싱 — 빈 문자열→null, JSON 파싱 시도, 실패 시 원문 문자열 그대로.
// (빌더의 트리거/엔드조건/결과값 기대값 입력 파싱에 공용)
export function parseVal(s: string): unknown {
  const t = s.trim();
  if (t === "") return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
