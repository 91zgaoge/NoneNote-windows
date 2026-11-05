export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** Wiki pages / note titles used for this answer. */
  sources?: string[];
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
