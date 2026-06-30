// 백엔드 / rosbridge 주소 — 페이지를 연 호스트 기준으로 자동 결정.
// localhost로 접속하면 localhost, 10.10.14.70으로 접속하면 10.10.14.70 의
// 백엔드로 연결되므로, 다른 PC에서 접속해도 동작한다.
const HOST = window.location.hostname || "localhost";

export const BACKEND_URL = `http://${HOST}:3001`;
export const ROSBRIDGE_URL = `ws://${HOST}:9090`;

// 라즈베리파이 lerobot 모방학습 비전(MJPEG) 직접 주소 — 브라우저가 파이와 같은 LAN일 때 폴백 연결용.
// 백엔드 프록시(/api/vision/policy-stream)가 안 되면 이 주소로 직접 붙는다.
export const POLICY_VISION_URL = "http://10.10.14.24:5000";
