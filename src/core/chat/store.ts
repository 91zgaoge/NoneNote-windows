import type { StorageAdapter } from "../../platform/storage.ts";
import type { ChatSession } from "./types.ts";

const KEY = "chat.sessions";

/** Local chat sessions (not synced; included in JSON backups). */
export class ChatSessionStore {
  private readonly storage: StorageAdapter;
  private cache: ChatSession[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async load(): Promise<ChatSession[]> {
    if (this.cache) return [...this.cache];
    const loaded = await this.storage.load<ChatSession[]>(KEY);
    this.cache = (Array.isArray(loaded) ? loaded : [])
      .filter(isSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return [...this.cache];
  }

  async save(sessions: ChatSession[]): Promise<void> {
    this.cache = sessions.filter(isSession);
    const snapshot = [...this.cache];
    const next = this.chain.then(() => this.storage.save(KEY, snapshot));
    this.chain = next.catch(() => undefined);
    await next;
  }
}

function isSession(v: unknown): v is ChatSession {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string" && Array.isArray(s.messages);
}
