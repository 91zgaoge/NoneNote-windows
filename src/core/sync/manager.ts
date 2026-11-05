import type { AppSettings, Note, SyncSnapshot } from "../types.ts";
import { SYNC_DELETION_LOCAL_OFF, SYNC_DELETION_REMOTE_OFF, SYNC_MODE_DOWNLOAD } from "../types.ts";
import type { NoteStore } from "../notes/store.ts";
import { decodeSnapshot, encodeSnapshot } from "./codec.ts";
import { merge } from "./merge.ts";
import type { SyncTransport } from "./webdav.ts";

export type SyncResult =
  | { kind: "not_configured" }
  | { kind: "ok"; noteCount: number }
  | { kind: "failed"; detail: string };

export interface SyncStateSink {
  save(deletedJson: string, knownIdsJson: string): Promise<void>;
}

const DEBOUNCE_MS = 2000;

/**
 * Serializes WebDAV sync: once at startup, then 2s-debounced after local
 * changes, plus manual triggers. Mirrors Android's SyncManager: tombstones
 * for vanished ids, policy gates for direction/deletions, and a payload hash
 * (with `updated` zeroed) to prevent sync loops.
 */
export class SyncManager {
  private readonly store: NoteStore;
  private readonly settings: () => AppSettings;
  private readonly sink: SyncStateSink;
  private readonly clientFactory: (cfg: AppSettings) => SyncTransport;
  private readonly onRemoteApplied: () => void;
  private readonly now: () => number;

  private deleted: Record<string, number> = {};
  private knownIds = new Set<string>();
  private lastPushedHash: number | null = null;
  private stateLoaded = false;
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  lastSyncAt: number | null = null;
  lastSyncResult: SyncResult | null = null;
  onStatus: (() => void) | null = null;

  constructor(opts: {
    store: NoteStore;
    settings: () => AppSettings;
    sink: SyncStateSink;
    clientFactory: (cfg: AppSettings) => SyncTransport;
    onRemoteApplied?: () => void;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.settings = opts.settings;
    this.sink = opts.sink;
    this.clientFactory = opts.clientFactory;
    this.onRemoteApplied = opts.onRemoteApplied ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.store.subscribe(() => this.schedule());
    void this.sync("startup");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync("auto");
    }, DEBOUNCE_MS);
  }

  /** Runs one sync pass; passes are serialized, never overlapping. */
  sync(trigger = "manual"): Promise<SyncResult> {
    const run = this.chain.then(() => this.runSync(trigger));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runSync(_trigger: string): Promise<SyncResult> {
    try {
      await this.ensureStateLoaded();
      const cfg = this.settings();
      if (!cfg.webdavUrl.trim()) {
        this.lastSyncResult = { kind: "not_configured" };
        this.onStatus?.();
        return this.lastSyncResult;
      }
      const client = this.clientFactory(cfg);
      const remoteJson = await client.pull();
      const remote: SyncSnapshot = remoteJson
        ? decodeSnapshot(remoteJson)
        : { updated: 0, notes: [], deleted: {}, attachments: {} };

      const now = this.now();
      const local = this.store.all();
      const localIds = new Set(local.map((n) => n.id));

      const pushEnabled = cfg.syncMode !== SYNC_MODE_DOWNLOAD;
      const applyEnabled = cfg.syncMode !== "upload";
      const propagateDeletes = cfg.syncDeletion !== SYNC_DELETION_LOCAL_OFF;
      const applyRemoteDeletes = cfg.syncDeletion !== SYNC_DELETION_REMOTE_OFF;

      const locallyDeleted = [...this.knownIds].filter((id) => !localIds.has(id));
      if (pushEnabled && propagateDeletes) {
        for (const id of locallyDeleted) {
          const remoteModified = remote.notes.find((n) => n.id === id)?.modified ?? 0;
          const base = Math.max(this.deleted[id] ?? 0, now, remoteModified + 1);
          // sync.json carries whole seconds; round up so the tombstone still
          // beats the remote copy after truncation on a peer.
          this.deleted[id] = Math.floor((base + 999) / 1000) * 1000;
        }
      }

      // Windows has no attachment editor yet. Reuse the remote metadata as the
      // local side so a note this client wins never drops its attachments.
      const localAttachments = remote.attachments;
      const merged = merge(local, this.deleted, remote, now, localAttachments);

      let applied = 0;
      if (applyEnabled) {
        applied = this.applyToStore(
          merged,
          propagateDeletes ? new Set() : new Set(locallyDeleted),
          applyRemoteDeletes ? new Set() : new Set(Object.keys(remote.deleted)),
        );
        if (applied > 0) this.onRemoteApplied();
      }

      this.deleted = { ...merged.deleted };
      this.knownIds = new Set(
        applyEnabled ? merged.notes.map((n) => n.id) : localIds,
      );
      await this.sink.save(JSON.stringify(this.deleted), JSON.stringify([...this.knownIds]));

      const hash = fnv1a(encodeSnapshot({ ...merged, updated: 0 }));
      if (pushEnabled && this.lastPushedHash !== hash) {
        await client.push(encodeSnapshot(merged));
        this.lastPushedHash = hash;
      }

      this.lastSyncAt = now;
      this.lastSyncResult = { kind: "ok", noteCount: merged.notes.length };
      this.onStatus?.();
      return this.lastSyncResult;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.lastSyncResult = { kind: "failed", detail };
      this.onStatus?.();
      return this.lastSyncResult;
    }
  }

  private applyToStore(
    merged: SyncSnapshot,
    skipApplyIds: Set<string>,
    keepIds: Set<string>,
  ): number {
    let changed = 0;
    const localById = new Map(this.store.all().map((n) => [n.id, n]));
    const mergedById = new Map(merged.notes.map((n) => [n.id, n]));
    for (const [id, note] of mergedById) {
      if (skipApplyIds.has(id)) continue;
      const local = localById.get(id);
      if (!local || !notesEqual(local, note)) {
        this.store.applyRemote(note);
        changed++;
      }
    }
    for (const id of localById.keys()) {
      if (!mergedById.has(id) && !keepIds.has(id)) {
        this.store.delete(id);
        changed++;
      }
    }
    return changed;
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const cfg = this.settings();
    try {
      const raw = JSON.parse(cfg.syncDeletedJson || "{}") as Record<string, number>;
      this.deleted = raw && typeof raw === "object" ? raw : {};
    } catch {
      this.deleted = {};
    }
    try {
      const raw = JSON.parse(cfg.syncKnownIdsJson || "[]") as string[];
      this.knownIds = new Set(Array.isArray(raw) ? raw : []);
    } catch {
      this.knownIds = new Set();
    }
  }
}

function notesEqual(a: Note, b: Note): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.body === b.body &&
    a.color === b.color &&
    a.created === b.created &&
    a.modified === b.modified &&
    a.archived === b.archived &&
    a.pinned === b.pinned &&
    a.order === b.order &&
    JSON.stringify(a.document ?? null) === JSON.stringify(b.document ?? null)
  );
}

/** Stable 32-bit FNV-1a; only used for local sync-loop detection. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
