import { useState } from "react";
import { useNestSocket } from "../hooks/useNestSocket";
import TopologyEditor from "./TopologyEditor";
import { RobotSection } from "./admin/RobotSection";
import { MapSection } from "./admin/MapSection";
import { NodeSection } from "./admin/NodeSection";
import { EdgeSection } from "./admin/EdgeSection";
import { TaskSection } from "./admin/TaskSection";

// ── 메인 AdminView ────────────────────────────────────────────────────────────

type AdminTab = "editor" | "robots" | "maps" | "nodes" | "edges" | "tasks";

const TABS: { id: AdminTab; label: string }[] = [
 { id: "editor", label: "⊞ 토폴로지 편집기" },
 { id: "robots", label: "로봇" },
 { id: "maps", label: "맵 (FleetMap)" },
 { id: "nodes", label: "노드" },
 { id: "edges", label: "엣지" },
 { id: "tasks", label: "태스크" },
];

export default function AdminView() {
 const [tab, setTab] = useState<AdminTab>("editor");
 const { robotStatuses } = useNestSocket();

 return (
 <div className="h-full flex flex-col bg-[#FFCE99]/14 backdrop-blur-xl text-white/90 overflow-hidden">
 {/* 탭 바 */}
 <div className="flex-none flex border-b border-white/[0.1] bg-[#FFCE99]/32 px-4 pt-2 gap-1">
 {TABS.map(t => (
 <button
 key={t.id}
 onClick={() => setTab(t.id)}
 className={`px-4 py-2 text-xs font-bold tracking-wider border-b-2 transition-colors ${
 tab === t.id
 ? "border-indigo-500 text-white/[0.82]"
 : "border-transparent text-white/[0.6] hover:text-white/[0.75]"
 }`}
 >
 {t.label}
 </button>
 ))}
 </div>

 {/* 컨텐츠 */}
 {tab === "editor" ? (
 <div className="flex-1 overflow-hidden">
 <TopologyEditor />
 </div>
 ) : (
 <div className="flex-1 overflow-y-auto overflow-x-auto p-3 sm:p-5">
 {tab === "robots" && <RobotSection liveStatuses={robotStatuses} />}
 {tab === "maps" && <MapSection />}
 {tab === "nodes" && <NodeSection />}
 {tab === "edges" && <EdgeSection />}
 {tab === "tasks" && <TaskSection />}
 </div>
 )}
 </div>
 );
}
