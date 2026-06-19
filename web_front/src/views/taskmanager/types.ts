// TaskManagerView 타입

export interface AgentAction {
  tool:   string;
  args:   Record<string, unknown>;
  result: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  loading?: boolean;
  actions?: AgentAction[];
  error?: boolean;
  fromStt?: boolean;
}

export interface TopoNode { node_id: string; x: number; y: number; type: string; }
