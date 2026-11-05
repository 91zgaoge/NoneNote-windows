import type { MemoryFact, MemoryState } from "./types.ts";
import { activeFacts } from "./ops.ts";
import type { StorageAdapter } from "../../platform/storage.ts";

const FACTS_KEY = "memory.facts";
const STATE_KEY = "memory.state";

/** Local-only fact store (Android keeps memory in Room and never syncs it). */
export class MemoryStore {
  private readonly storage: StorageAdapter;
  private facts: MemoryFact[] | null = null;
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<MemoryFact[]> {
    if (this.facts) return [...this.facts];
    const loaded = await this.storage.load<MemoryFact[]>(FACTS_KEY);
    this.facts = (Array.isArray(loaded) ? loaded : []).filter(isFact);
    return [...this.facts];
  }

  /** Active heads (expired/forgotten/superseded excluded) — for prompts. */
  async active(today: string): Promise<MemoryFact[]> {
    return activeFacts(await this.load(), today);
  }

  /** Latest, non-forgotten rows (including not-yet-swept expired) — for UI. */
  async visible(): Promise<MemoryFact[]> {
    return (await this.load())
      .filter((f) => f.isLatest && !f.forgotten)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async inferred(): Promise<MemoryFact[]> {
    return (await this.load())
      .filter((f) => f.isInference && f.isLatest && !f.forgotten)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async byId(id: string): Promise<MemoryFact | undefined> {
    return (await this.load()).find((f) => f.id === id);
  }

  async upsert(fact: MemoryFact): Promise<void> {
    const list = await this.load();
    this.facts = list.some((f) => f.id === fact.id)
      ? list.map((f) => (f.id === fact.id ? fact : f))
      : [...list, fact];
    this.emit();
    await this.persist();
  }

  async markSuperseded(id: string, now: number): Promise<void> {
    await this.update(id, (f) => ({ ...f, isLatest: false, updatedAt: now }));
  }

  async incrementSourceCount(id: string, now: number): Promise<void> {
    await this.update(id, (f) => ({ ...f, sourceCount: f.sourceCount + 1, updatedAt: now }));
  }

  async softForget(id: string, reason: string, now: number): Promise<void> {
    await this.update(id, (f) => ({
      ...f,
      forgotten: true,
      forgetReason: reason,
      updatedAt: now,
    }));
  }

  async approve(id: string, now: number): Promise<void> {
    await this.update(id, (f) => ({ ...f, isInference: false, updatedAt: now }));
  }

  async decline(id: string, now: number): Promise<void> {
    await this.softForget(id, "declined", now);
  }

  /** Hard-expires every fact whose forgetAfter has passed; returns the count. */
  async expireBefore(today: string, now: number): Promise<number> {
    const list = await this.load();
    let count = 0;
    this.facts = list.map((f) => {
      if (f.forgetAfter && f.forgetAfter < today && !f.forgotten) {
        count++;
        return { ...f, forgotten: true, forgetReason: "expired", updatedAt: now };
      }
      return f;
    });
    if (count > 0) {
      this.emit();
      await this.persist();
    }
    return count;
  }

  async pruneForgotten(before: number): Promise<number> {
    const list = await this.load();
    const next = list.filter((f) => !(f.forgotten && f.updatedAt < before));
    const removed = list.length - next.length;
    if (removed > 0) {
      this.facts = next;
      this.emit();
      await this.persist();
    }
    return removed;
  }

  async loadState(): Promise<MemoryState> {
    const state = await this.storage.load<MemoryState>(STATE_KEY);
    return {
      noteHashes: state?.noteHashes ?? {},
      chatIds: Array.isArray(state?.chatIds) ? state.chatIds : [],
    };
  }

  async saveState(state: MemoryState): Promise<void> {
    await this.storage.save(STATE_KEY, state);
  }

  private async update(id: string, f: (fact: MemoryFact) => MemoryFact): Promise<void> {
    const list = await this.load();
    if (!list.some((x) => x.id === id)) return;
    this.facts = list.map((x) => (x.id === id ? f(x) : x));
    this.emit();
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = [...(this.facts ?? [])];
    const next = this.chain.then(() => this.storage.save(FACTS_KEY, snapshot));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

function isFact(v: unknown): v is MemoryFact {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.fact === "string" && typeof f.contentHash === "string";
}
