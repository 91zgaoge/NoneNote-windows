export type AgentActionKind =
  | "create"
  | "append"
  | "color"
  | "archive"
  | "delete"
  | "due"
  | "event"
  | "diagram";
export type AgentActionStatus = "pending" | "done" | "failed" | "cancelled";
export type AgentFailReason =
  | "not_found"
  | "ambiguous"
  | "missing_text"
  | "missing_target"
  | "bad_color"
  | "bad_date"
  | "bad_time"
  | "bad_elements"
  | "execution_failed";

/** One ```noty action parsed from an assistant answer. */
export interface AgentAction {
  kind: AgentActionKind;
  id?: string;
  title?: string;
  text?: string;
  color?: number;
  colorName?: string;
  dueOn?: string;
  time?: string;
  /** Excalidraw elements for the `diagram` action (validated at execution). */
  elements?: unknown[];
  status: AgentActionStatus;
  fail?: AgentFailReason;
  targetId?: string;
  targetTitle?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** Wiki pages / note titles used for this answer. */
  sources?: string[];
  /** Note actions carried by this answer; destructive ones stay pending. */
  actions?: AgentAction[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface RetrievalChunk {
  kind: "page" | "note";
  name: string;
  text: string;
  score: number;
}
