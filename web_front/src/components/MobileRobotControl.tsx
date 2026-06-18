import { useState, useCallback, useRef } from "react";
import { CmdVelPayload } from "../hooks/useNestSocket";

interface Props {
 botId: string;
 emitCmdVel: (payload: CmdVelPayload) => void;
 linearSpeed?: number;
 angularSpeed?: number;
}

export default function MobileRobotControl({
 botId, emitCmdVel, linearSpeed = 0.2, angularSpeed = 1.0
}: Props) {
 const [activeDir, setActiveDir] = useState<string | null>(null);
 const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

 const startMoving = useCallback((dir: string) => {
 setActiveDir(dir);
 if (timerRef.current) clearInterval(timerRef.current);

 const move = () => {
 let linear = 0;
 let angular = 0;
 if (dir === "W") linear = linearSpeed;
 if (dir === "S") linear = -linearSpeed;
 if (dir === "A") angular = angularSpeed;
 if (dir === "D") angular = -angularSpeed;
 emitCmdVel({ botId, linear, angular });
 };

 move();
 timerRef.current = setInterval(move, 100);
 }, [botId, emitCmdVel, linearSpeed, angularSpeed]);

 const stopMoving = useCallback(() => {
 setActiveDir(null);
 if (timerRef.current) clearInterval(timerRef.current);
 emitCmdVel({ botId, linear: 0, angular: 0 });
 }, [botId, emitCmdVel]);

 return (
 <div className="sm:hidden fixed bottom-20 right-5 flex flex-col items-center gap-1 z-50 opacity-80 active:opacity-100">
 <ControlButton label="W" active={activeDir === "W"} onStart={() => startMoving("W")} onEnd={stopMoving} />
 <div className="flex gap-1">
 <ControlButton label="A" active={activeDir === "A"} onStart={() => startMoving("A")} onEnd={stopMoving} />
 <ControlButton label="S" active={activeDir === "S"} onStart={() => startMoving("S")} onEnd={stopMoving} />
 <ControlButton label="D" active={activeDir === "D"} onStart={() => startMoving("D")} onEnd={stopMoving} />
 </div>
 </div>
 );
}

function ControlButton({ label, active, onStart, onEnd }: { 
 label: string; active: boolean; onStart: () => void; onEnd: () => void 
}) {
 return (
 <button
 onMouseDown={(e) => { e.preventDefault(); onStart(); }}
 onMouseUp={(e) => { e.preventDefault(); onEnd(); }}
 onMouseLeave={(e) => { e.preventDefault(); onEnd(); }}
 onTouchStart={(e) => { e.preventDefault(); onStart(); }}
 onTouchEnd={(e) => { e.preventDefault(); onEnd(); }}
 className={`w-14 h-14 rounded-xl border-2 flex items-center justify-center font-bold text-base select-none transition-all ${
 active
 ? "bg-orange-500 border-orange-400 text-white scale-95 shadow-lg shadow-orange-500/30"
 : "bg-[#FFCE99]/32 border-white/[0.1] text-white/[0.82] hover:border-orange-500/30"
 }`}
 >
 {label}
 </button>
 );
}
