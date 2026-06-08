import { useRef, useEffect, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";

const BACKEND = "http://localhost:3001";

// ── 타입 ──────────────────────────────────────────────────────────────────────

type Status = "idle" | "requesting" | "connecting" | "streaming" | "error";

interface Props {
  botId: string;
  label: string;
  socket: Socket | null;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function CameraFeed({ botId, label, socket }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef    = useRef<RTCPeerConnection | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  // 비전 분석 상태
  const [analyzing, setAnalyzing]       = useState(false);
  const [analysisText, setAnalysisText] = useState<string | null>(null);

  // ── PeerConnection 정리 ───────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
  }, []);

  // ── 연결 시작 ─────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!socket) return;
    // 살아있는 pc가 있으면 중복 방지. 닫힌 pc면 정리 후 재생성 (StrictMode 대응)
    if (pcRef.current) {
      if (pcRef.current.connectionState !== "closed") return;
      pcRef.current.close();
      pcRef.current = null;
    }
    setStatus("requesting");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // 비디오 트랙 수신
    pc.ontrack = (e) => {
      if (videoRef.current && e.streams[0]) {
        videoRef.current.srcObject = e.streams[0];
        setStatus("streaming");
      }
    };

    // ICE candidate → 서버 경유 로봇으로 전달
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_ice", {
          botId,
          candidate: e.candidate.toJSON(),
          target: "robot",
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        setStatus("error");
      }
    };

    // 서버에 스트림 요청
    socket.emit("webrtc_request_stream", { botId });
  }, [botId, socket]);

  // ── 시그널링 이벤트 수신 ─────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // 서버가 로봇의 Offer를 중계해 줌
    const onOffer = async ({
      botId: bid,
      sdp,
    }: {
      botId: string;
      sdp: RTCSessionDescriptionInit;
    }) => {
      if (bid !== botId || !pcRef.current) return;
      setStatus("connecting");
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit("webrtc_answer", {
          botId,
          sdp: { type: answer.type, sdp: answer.sdp },
        });
      } catch {
        setStatus("error");
      }
    };

    // 서버가 로봇의 ICE candidate를 중계해 줌
    const onIce = ({
      botId: bid,
      candidate,
    }: {
      botId: string;
      candidate: RTCIceCandidateInit;
    }) => {
      if (bid !== botId || !pcRef.current) return;
      pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    };

    // 로봇 미연결 오류
    const onError = ({ botId: bid }: { botId: string }) => {
      if (bid === botId) setStatus("error");
    };

    // 로봇 오프라인 알림
    const onOffline = ({ botId: bid }: { botId: string }) => {
      if (bid === botId) cleanup();
    };

    socket.on("webrtc_offer",          onOffer);
    socket.on("webrtc_ice",            onIce);
    socket.on("webrtc_error",          onError);
    socket.on("robot_camera_offline",  onOffline);

    return () => {
      socket.off("webrtc_offer",         onOffer);
      socket.off("webrtc_ice",           onIce);
      socket.off("webrtc_error",         onError);
      socket.off("robot_camera_offline", onOffline);
    };
  }, [socket, botId, cleanup]);

  // ── 마운트 시 자동 연결 (socket 준비되면 바로 스트림 요청) ──────────────────
  useEffect(() => {
    if (socket) connect();
  }, [socket, connect]);

  // ── 연결 실패/끊김 시 자동 재연결 (3초 후 재시도) ──────────────────────────
  useEffect(() => {
    if (status !== "error") return;
    const t = setTimeout(() => {
      cleanup();   // pcRef 정리 → idle
      connect();   // 즉시 재연결
    }, 3000);
    return () => clearTimeout(t);
  }, [status, cleanup, connect]);

  // 언마운트 시 정리 (close + null — 재마운트 시 깨끗하게 재연결)
  useEffect(() => () => { pcRef.current?.close(); pcRef.current = null; }, []);

  // ── 현재 프레임 캡처 → LLaVA 분석 ──────────────────────────────────────────
  const captureAndAnalyze = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    // 비디오 현재 프레임을 캔버스에 그려 JPEG base64로 변환
    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);

    setAnalyzing(true);
    setAnalysisText(null);
    try {
      const res = await fetch(`${BACKEND}/api/vision/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl, botId }),
      });
      const json = (await res.json()) as { ok: boolean; text: string; message?: string };
      setAnalysisText(json.ok ? json.text : `분석 실패: ${json.message ?? "알 수 없음"}`);
    } catch {
      setAnalysisText("분석 요청 실패 — 백엔드/Ollama 확인");
    } finally {
      setAnalyzing(false);
    }
  }, [botId]);

  // ── 렌더 ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative bg-[#050810] border border-[#1e1e1e] overflow-hidden"
         style={{ aspectRatio: "16/9" }}>

      {/* 비디오 스트림 */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-cover"
      />

      {/* 비스트리밍 오버레이 */}
      {status !== "streaming" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#050810]/90">
          <p className={`text-[10px] font-mono font-bold uppercase tracking-widest ${
            status === "error"                        ? "text-red-500" :
            status === "requesting" || status === "connecting" ? "text-amber-400 animate-pulse" :
            "text-[#2a2a2a]"
          }`}>
            {status === "idle"       ? "NO SIGNAL" :
             status === "requesting" ? "CONNECTING..." :
             status === "connecting" ? "NEGOTIATING..." :
             "ERROR"}
          </p>
          {status === "idle" && (
            <button
              onClick={connect}
              disabled={!socket}
              className="px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-widest
                         border border-[#2a2a2a] text-[#555555]
                         hover:border-[#444444] hover:text-[#888888] transition-all
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              연결
            </button>
          )}
          {status === "error" && (
            <button
              onClick={cleanup}
              className="px-3 py-1 text-[9px] font-mono font-bold uppercase tracking-widest
                         border border-red-900/50 text-red-500
                         hover:border-red-700 hover:text-red-400 transition-all"
            >
              재시도
            </button>
          )}
        </div>
      )}

      {/* 상단 레이블 */}
      <div className="absolute top-1.5 left-1.5 flex items-center gap-1.5 pointer-events-none">
        <div className={`w-1.5 h-1.5 rounded-full flex-none ${
          status === "streaming" ? "bg-red-500 animate-pulse" :
          status === "error"     ? "bg-red-800" : "bg-[#1e1e1e]"
        }`} />
        <span className="text-[8px] font-mono text-[#555555] uppercase tracking-widest">{label}</span>
      </div>

      {/* 스트리밍 중 우상단 버튼들 (분석 / 해제) */}
      {status === "streaming" && (
        <div className="absolute top-1 right-1 flex items-center gap-1">
          <button
            onClick={captureAndAnalyze}
            disabled={analyzing}
            title="현재 프레임 AI 분석"
            className={`px-1.5 h-5 flex items-center justify-center text-[9px] font-mono font-bold
                       border transition-all ${
              analyzing
                ? "border-amber-700/50 text-amber-400 animate-pulse cursor-wait"
                : "border-cyan-800/50 bg-cyan-950/30 text-cyan-400 hover:border-cyan-600/70 hover:text-cyan-300"
            }`}
          >
            {analyzing ? "분석중…" : "🔍 분석"}
          </button>
          <button
            onClick={cleanup}
            className="w-5 h-5 flex items-center justify-center
                       text-[9px] text-[#333333] hover:text-[#888888] transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* AI 분석 결과 오버레이 (하단) */}
      {analysisText !== null && (
        <div className="absolute bottom-0 left-0 right-0 max-h-[55%] overflow-y-auto
                        bg-[#04060a]/95 border-t border-cyan-900/40 p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[8px] font-mono font-bold text-cyan-500 uppercase tracking-widest">
              ◈ AI 분석 — {label}
            </span>
            <button
              onClick={() => setAnalysisText(null)}
              className="text-[9px] text-[#444444] hover:text-[#888888] transition-colors leading-none"
            >
              ✕
            </button>
          </div>
          <p className="text-[10px] text-cyan-100/90 leading-relaxed whitespace-pre-wrap">
            {analysisText}
          </p>
        </div>
      )}
    </div>
  );
}
