import type { Note } from "../core/types.ts";
import type { NotePersistence } from "../core/notes/store.ts";
import type { StorageAdapter } from "../platform/storage.ts";

const KEY = "notes";

/** Whole-file note persistence; writes are serialized to keep order stable. */
export class JsonNotePersistence implements NotePersistence {
  private readonly storage: StorageAdapter;
  private cache: Note[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async load(): Promise<Note[]> {
    if (this.cache) return [...this.cache];
    const loaded = (await this.storage.load<Note[]>(KEY)) ?? [];
    this.cache = loaded.filter(isNote);
    return [...this.cache];
  }

  async upsert(note: Note): Promise<void> {
    await this.mutate((list) => {
      const idx = list.findIndex((n) => n.id === note.id);
      return idx < 0 ? [...list, note] : list.map((n) => (n.id === note.id ? note : n));
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((list) => list.filter((n) => n.id !== id));
  }

  async replaceAll(notes: Note[]): Promise<void> {
    this.cache = notes;
    await this.enqueueSave();
  }

  private async mutate(f: (list: Note[]) => Note[]): Promise<void> {
    if (!this.cache) await this.load();
    this.cache = f(this.cache ?? []);
    await this.enqueueSave();
  }

  private enqueueSave(): Promise<void> {
    const snapshot = [...(this.cache ?? [])];
    const next = this.chain.then(() => this.storage.save(KEY, snapshot));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

function isNote(v: unknown): v is Note {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return typeof n.id === "string" && typeof n.body === "string";
}
