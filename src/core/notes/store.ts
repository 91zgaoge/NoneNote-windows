import type { Note } from "../types.ts";
import { derivedTitle } from "../text.ts";
import { projectDocument } from "../document.ts";
import { uuid } from "../text.ts";

export interface NotePersistence {
  load(): Promise<Note[]>;
  upsert(note: Note): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface PendingDelete {
  note: Note;
  deadline: number;
}

const UNDO_WINDOW_MS = 5000;
const DEFAULT_WELCOME =
  "Welcome to NoneNote\n\nNotes sync across Android, macOS, iOS and Windows through WebDAV. " +
  "Open Settings to connect your server.";

/**
 * Single source of truth for notes on Windows. Mirrors Android's NoteStore
 * semantics (ordering, derived titles, undo window, verbatim applyRemote).
 */
export class NoteStore {
  private notes: Note[] = [];
  private pending: PendingDelete | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  private readonly persistence: NotePersistence;
  private readonly undoWindowMs: number;
  private readonly welcomeBody: string;

  constructor(
    persistence: NotePersistence,
    undoWindowMs = UNDO_WINDOW_MS,
    welcomeBody: string = DEFAULT_WELCOME,
  ) {
    this.persistence = persistence;
    this.undoWindowMs = undoWindowMs;
    this.welcomeBody = welcomeBody;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  all(): Note[] {
    return [...this.notes];
  }

  active(): Note[] {
    return this.notes.filter((n) => !n.archived).sort((a, b) => a.order - b.order);
  }

  archived(): Note[] {
    return this.notes.filter((n) => n.archived).sort((a, b) => b.modified - a.modified);
  }

  note(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  pendingDelete(): PendingDelete | null {
    return this.pending;
  }

  async loadInitial(): Promise<void> {
    const loaded = await this.persistence.load();
    if (this.notes.length === 0 && loaded.length === 0) {
      const welcome = this.withAutoTitle({
        id: uuid(),
        title: "",
        body: this.welcomeBody,
        color: 0,
        created: Date.now(),
        modified: Date.now(),
        archived: false,
        pinned: false,
        order: 0,
        document: null,
      });
      this.notes = [welcome];
      await this.safeUpsert(welcome);
      this.emit();
      return;
    }
    if (this.notes.length === 0) {
      this.notes = loaded;
    } else {
      const ids = new Set(this.notes.map((n) => n.id));
      for (const n of loaded) {
        if (!ids.has(n.id)) {
          this.notes.push(n);
          await this.safeUpsert(n);
        }
      }
    }
    this.emit();
  }

  private withAutoTitle(n: Note): Note {
    return { ...n, title: n.title || derivedTitle(n.body) };
  }

  private async safeUpsert(n: Note): Promise<void> {
    try {
      await this.persistence.upsert(n);
    } catch {
      /* persistence errors surface through the settings/status UI */
    }
  }

  private async safeRemove(id: string): Promise<void> {
    try {
      await this.persistence.remove(id);
    } catch {
      /* ignore */
    }
  }

  private mutate(id: string, f: (n: Note) => Note): void {
    const idx = this.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const next = f(this.notes[idx]);
    this.notes = this.notes.map((n) => (n.id === id ? next : n));
    this.emit();
    void this.safeUpsert(next);
  }

  create(body = "", color?: number, title?: string): Note {
    const topOrder = (this.active().reduce((m, n) => Math.min(m, n.order), 1) ?? 1) - 1;
    const base: Note = {
      id: uuid(),
      title: "",
      body,
      color: color ?? this.active().length % 8,
      created: Date.now(),
      modified: Date.now(),
      archived: false,
      pinned: false,
      order: topOrder,
      document: null,
    };
    const n = { ...base, title: title ?? derivedTitle(body) };
    this.notes = [...this.notes, n];
    this.emit();
    void this.safeUpsert(n);
    return n;
  }

  updateBody(id: string, body: string): void {
    const cur = this.note(id);
    if (!cur || cur.body === body) return;
    this.mutate(id, (n) => {
      const autoTitle = n.title.length === 0 || n.title === derivedTitle(n.body);
      return {
        ...n,
        body,
        document: null,
        title: autoTitle ? derivedTitle(body) : n.title,
        modified: Date.now(),
      };
    });
  }

  setTitle(id: string, title: string): void {
    const cur = this.note(id);
    if (!cur) return;
    const clean = title.trim() || derivedTitle(cur.body);
    if (cur.title === clean) return;
    this.mutate(id, (n) => ({ ...n, title: clean, modified: Date.now() }));
  }

  /** Bumps `modified` without changing content (e.g. after adding an attachment). */
  touch(id: string): void {
    this.mutate(id, (n) => ({ ...n, modified: Date.now() }));
  }

  togglePin(id: string): void {
    this.mutate(id, (n) => ({ ...n, pinned: !n.pinned }));
  }

  setColor(id: string, color: number): void {
    this.mutate(id, (n) => ({ ...n, color, modified: Date.now() }));
  }

  setArchived(id: string, archived: boolean): void {
    const topOrder = (this.active().reduce((m, n) => Math.min(m, n.order), 1) ?? 1) - 1;
    this.mutate(id, (n) =>
      archived
        ? { ...n, archived: true, pinned: false }
        : { ...n, archived: false, order: topOrder },
    );
  }

  delete(id: string): void {
    const n = this.note(id);
    if (!n) return;
    this.notes = this.notes.filter((x) => x.id !== id);
    const superseded = this.pending;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    if (superseded) void this.safeRemove(superseded.note.id);
    this.pending = { note: n, deadline: Date.now() + this.undoWindowMs };
    this.emit();
    this.undoTimer = setTimeout(() => {
      this.pending = null;
      this.undoTimer = null;
      void this.safeRemove(id);
      this.emit();
    }, this.undoWindowMs);
  }

  undoDelete(): void {
    const p = this.pending;
    if (!p) return;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.pending = null;
    this.notes = [...this.notes, p.note];
    this.emit();
    void this.safeUpsert(p.note);
  }

  reorder(id: string, bySlots: number): void {
    const list = this.active();
    const from = list.findIndex((n) => n.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, from + bySlots));
    if (to === from) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    const orderById = new Map(list.map((n, i) => [n.id, i]));
    this.notes = this.notes.map((n) =>
      orderById.has(n.id) ? { ...n, order: orderById.get(n.id)! } : n,
    );
    this.emit();
    for (const n of this.notes) {
      if (orderById.has(n.id)) void this.safeUpsert(n);
    }
  }

  /** Upserts a note coming from sync, verbatim (order included). */
  applyRemote(n: Note): void {
    const exists = this.notes.some((x) => x.id === n.id);
    this.notes = exists
      ? this.notes.map((x) => (x.id === n.id ? n : x))
      : [...this.notes, n];
    this.emit();
    void this.safeUpsert(n);
  }

  /** Imports foreign notes, regenerating colliding ids. */
  ingest(incoming: Note[]): number {
    let nextOrder = this.notes.reduce((m, n) => Math.min(m, n.order), 1) - 1;
    const ids = new Set(this.notes.map((n) => n.id));
    const added: Note[] = [];
    for (const n of incoming) {
      let note = { ...n };
      if (ids.has(note.id)) note = { ...note, id: uuid() };
      if (!note.title) note = { ...note, title: derivedTitle(note.body) };
      note = { ...note, order: nextOrder };
      nextOrder -= 1;
      ids.add(note.id);
      added.push(note);
    }
    this.notes = [...this.notes, ...added];
    this.emit();
    for (const n of added) void this.safeUpsert(n);
    return added.length;
  }

  /** Replace the whole set (backup restore), deleting old rows not in [next]. */
  replaceAll(next: Note[]): void {
    const keep = new Set(next.map((n) => n.id));
    for (const old of this.notes) {
      if (!keep.has(old.id)) void this.safeRemove(old.id);
    }
    this.notes = next;
    this.emit();
    for (const n of next) void this.safeUpsert(n);
  }
}

/** Re-export for tests that want the GFM projection of a note document. */
export { projectDocument };
