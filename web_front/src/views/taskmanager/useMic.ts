// 음성 인식(STT) 훅 — Web Speech API
import { useState, useRef, useCallback } from "react";

export function useMic(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim]     = useState("");
  const recRef = useRef<SpeechRecognition | null>(null);

  const start = useCallback(() => {
    const API = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!API) { alert("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)"); return; }
    const rec: SpeechRecognition = new API();
    rec.lang = "ko-KR"; rec.continuous = false; rec.interimResults = true;
    let finalBuf = "";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interimBuf = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalBuf += e.results[i][0].transcript;
        else interimBuf += e.results[i][0].transcript;
      }
      setInterim(interimBuf);
    };
    rec.onend = () => { setListening(false); setInterim(""); recRef.current = null; if (finalBuf.trim()) onResult(finalBuf.trim()); };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => { if (e.error !== "aborted") console.error("STT:", e.error); setListening(false); setInterim(""); recRef.current = null; };
    recRef.current = rec; rec.start(); setListening(true); finalBuf = "";
  }, [onResult]);

  const stop   = useCallback(() => { recRef.current?.stop(); }, []);
  const toggle = useCallback(() => { if (listening) stop(); else start(); }, [listening, start, stop]);
  return { listening, interim, toggle };
}
