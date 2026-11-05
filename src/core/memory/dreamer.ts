import type { Attachment, Note } from "../types.ts";
import type { LlmClient } from "../ai/client.ts";
import { extractJson } from "../ai/jsonExtract.ts";
import { documentProjectionForAi } from "../document.ts";
import { contentHash } from "../wiki/text.ts";
import { uuid } from "../text.ts";
import type { MemoryStore } from "./store.ts";
import { planMemory, type FactView } from "./ops.ts";
import type { ExtractFact, MemoryFact, MemoryState } from "./types.ts";

export interface DreamSummary {
  inserted: number;
  superseded: number;
  corroborated: number;
  expired: number;
}

export interface ConversationLine {
  id: string;
  text: string;
}

export interface DreamDeps {
  llmFactory: () => LlmClient;
  store: MemoryStore;
  notes: () => Note[];
  conversation?: () => ConversationLine[] | Promise<ConversationLine[]>;
  attachments?: () => Promise<Attachment[]>;
  now?: () => number;
  today?: () => string;
  idGen?: () => string;
  maxCatalogChars?: number;
  maxInputChars?: number;
}

export const MAX_REMEMBERED_CHAT_IDS = 500;

const DREAM_SYSTEM =
  "You are the memory layer of a personal note-taking app. The input is the user's own " +
  "private notes and conversations; extract only facts ABOUT THE USER — identity, " +
  "preferences, plans, relationships, ongoing projects, current states. Never record " +
  "world knowledge, chit-chat, or one-off tasks.\n" +
  "You are given the current memory catalog (existing facts with ids) and new material. " +
  "Respond ONLY with a JSON array, one object per fact: " +
  '{"fact":...,"kind":"static"|"dynamic","relation":"add"|"updates"|"extends"|"derives",' +
  '"targetId":...,"forgetAfter":"yyyy-MM-dd"}.\n' +
  '- kind "static": enduring traits (identity, preferences, long-term projects). ' +
  '"dynamic": time-bound states and plans.\n' +
  '- relation "updates": the new fact contradicts or replaces a catalog entry — set ' +
  'targetId to its id. "extends": it adds detail to a catalog entry — set targetId. ' +
  '"derives": your own inference, not explicitly stated. "add": unrelated to the catalog.\n' +
  "- forgetAfter only for facts with a clear expiry date; omit it otherwise.\n" +
  "Write facts in the dominant language of the material. When nothing is worth " +
  "remembering, respond with []. No prose, no code fences.";

/**
 * Extracts atomic user facts from changed notes and new chat lines. All
 * versioning/dedup/expiry decisions happen in `planMemory`; a garbage model
 * response persists nothing and the next run retries the same input.
 */
export class MemoryDreamer {
  private readonly deps: DreamDeps;

  constructor(deps: DreamDeps) {
    this.deps = deps;
  }

  async dream(): Promise<DreamSummary | null> {
    const now = this.deps.now ?? (() => Date.now());
    const todayFn = this.deps.today ?? (() => localToday(now()));
    const idGen = this.deps.idGen ?? (() => uuid());
    const today = todayFn();
    const notes = this.deps.notes();
    const atts = await (this.deps.attachments?.() ?? Promise.resolve([]));
    const attsByNote = new Map<string, Attachment[]>();
    for (const a of atts) {
      const arr = attsByNote.get(a.noteId) ?? [];
      arr.push(a);
      attsByNote.set(a.noteId, arr);
    }
    const state = await this.deps.store.loadState();
    const hashes: Record<string, string> = {};
    for (const n of notes) {
      hashes[n.id] = await contentHash(n, attsByNote.get(n.id) ?? []);
    }
    const changed = notes.filter((n) => state.noteHashes[n.id] !== hashes[n.id]);
    const seen = new Set(state.chatIds);
    const conversation = (await this.deps.conversation?.()) ?? [];
    const newLines = conversation.filter((l) => !seen.has(l.id));
    if (changed.length === 0 && newLines.length === 0) {
      return { inserted: 0, superseded: 0, corroborated: 0, expired: 0 };
    }

    const existing = await this.deps.store.active(today);
    const extracted = await this.extract(existing, changed, newLines, attsByNote);
    if (extracted === null) return null;

    const plan = planMemory(existing.map(toView), extracted, idGen);
    const ts = now();
    const sourceIds = JSON.stringify(changed.map((n) => n.id));
    for (const id of plan.supersedeIds) await this.deps.store.markSuperseded(id, ts);
    for (const id of plan.incrementIds) await this.deps.store.incrementSourceCount(id, ts);
    for (const f of plan.inserts) {
      await this.deps.store.upsert({
        ...f,
        sourceNoteIds: sourceIds,
        sourceCount: 1,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    const expired = await this.deps.store.expireBefore(today, ts);
    const nextState: MemoryState = {
      noteHashes: hashes,
      chatIds: [...state.chatIds, ...newLines.map((l) => l.id)].slice(
        -MAX_REMEMBERED_CHAT_IDS,
      ),
    };
    await this.deps.store.saveState(nextState);
    return {
      inserted: plan.inserts.length,
      superseded: plan.supersedeIds.length,
      corroborated: plan.incrementIds.length,
      expired,
    };
  }

  /** Null = parse/LLM failure; the caller keeps the old state and retries. */
  private async extract(
    existing: MemoryFact[],
    changed: Note[],
    newLines: ConversationLine[],
    attsByNote: Map<string, Attachment[]>,
  ): Promise<ExtractFact[] | null> {
    const maxCatalog = this.deps.maxCatalogChars ?? 4_000;
    const maxInput = this.deps.maxInputChars ?? 12_000;
    let catalog = "";
    for (const f of existing) {
      const line = `- [${f.id}] (${f.kind}) ${f.fact.replace(/\n/g, " ")}\n`;
      if (catalog.length + line.length > maxCatalog) break;
      catalog += line;
    }
    catalog = catalog.trim();

    let user = "";
    if (catalog) user += "CURRENT MEMORY CATALOG\n" + catalog + "\n\n";
    // The catalog has its own cap; notes + conversation share maxInputChars
    // exactly like Android's dreamer.
    let inputChars = 0;
    if (changed.length > 0) {
      user += "NEW NOTES\n";
      for (const n of changed) {
        const block =
          documentProjectionForAi(n, attsByNote.get(n.id) ?? [], maxInput) + "\n---\n";
        if (inputChars + block.length > maxInput) break;
        user += block;
        inputChars += block.length;
      }
      user += "\n";
    }
    if (newLines.length > 0) {
      user += "NEW CONVERSATION LINES\n";
      for (const line of newLines) {
        const text = `- ${line.text.replace(/\n/g, " ")}\n`;
        if (inputChars + text.length > maxInput) break;
        user += text;
        inputChars += text.length;
      }
    }

    let raw: string;
    try {
      raw = await this.deps.llmFactory().chat(DREAM_SYSTEM, user);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(extractJson(raw)) as unknown;
      if (!Array.isArray(parsed)) return null;
      const out: ExtractFact[] = [];
      for (const el of parsed) {
        if (!el || typeof el !== "object") continue;
        const o = el as Record<string, unknown>;
        const fact = typeof o.fact === "string" ? o.fact.trim() : "";
        if (!fact) continue;
        out.push({
          fact,
          kind: typeof o.kind === "string" ? o.kind : "static",
          relation: typeof o.relation === "string" ? o.relation : "add",
          targetId: typeof o.targetId === "string" ? o.targetId : null,
          forgetAfter: typeof o.forgetAfter === "string" ? o.forgetAfter : null,
        });
      }
      return out;
    } catch {
      return null;
    }
  }
}

function toView(f: MemoryFact): FactView {
  return {
    id: f.id,
    fact: f.fact,
    kind: f.kind,
    relation: f.relation,
    parentId: f.parentId,
    rootId: f.rootId,
    isLatest: f.isLatest,
    isInference: f.isInference,
    forgetAfter: f.forgetAfter,
    contentHash: f.contentHash,
  };
}

export function localToday(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
