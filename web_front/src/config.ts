// 백엔드 / rosbridge 주소 — 페이지를 연 호스트 기준으로 자동 결정.
// localhost로 접속하면 localhost, 10.10.14.70으로 접속하면 10.10.14.70 의
// 백엔드로 연결되므로, 다른 PC에서 접속해도 동작한다.
const HOST = window.location.hostname || "localhost";

export const BACKEND_URL = `http://${HOST}:3001`;
export const ROSBRIDGE_URL = `ws://${HOST}:9090`;
