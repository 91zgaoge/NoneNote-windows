import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncManager } from "./manager.ts";
import { decodeSnapshot, encodeSnapshot } from "./codec.ts";
import type { SyncTransport } from "./webdav.ts";
import { NoteStore, type NotePersistence } from "../notes/store.ts";
import type { AppSettings, Attachment, Note, SyncSnapshot } from "../types.ts";
import { emptySettings, SYNC_MODE_DOWNLOAD, SYNC_DELETION_LOCAL_OFF } from "../types.ts";

class MemoryPersistence implements NotePersistence {
  notes: Note[] = [];
  async load(): Promise<Note[]> {
    return this.notes;
  }
  async upsert(n: Note): Promise<void> {
    const i = this.notes.findIndex((x) => x.id === n.id);
    this.notes = i < 0 ? [...this.notes, n] : this.notes.map((x) => (x.id === n.id ? n : x));
  }
  async remove(id: string): Promise<void> {
    this.notes = this.notes.filter((n) => n.id !== id);
  }
}

class FakeTransport implements SyncTransport {
  json: string | null;
  pushed = 0;

  constructor(json: string | null = null) {
    this.json = json;
  }

  async pull(): Promise<string | null> {
    return this.json;
  }

  async push(json: string): Promise<void> {
    this.pushed++;
    this.json = json;
  }
}

function note(id: string, modified: number, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: id,
    body: `body ${id}`,
    color: 0,
    created: 1,
    modified,
    archived: false,
    pinned: false,
    order: 0,
    ...extra,
  };
}

async function setup(opts: {
  local?: Note[];
  remote?: SyncSnapshot;
  settings?: Partial<AppSettings>;
  attachments?: Record<string, Attachment[]>;
}) {
  const settings: AppSettings = { ...emptySettings(), webdavUrl: "https://dav.example", ...opts.settings };
  const sink = {
    async save(deletedJson: string, knownIdsJson: string) {
      settings.syncDeletedJson = deletedJson;
      settings.syncKnownIdsJson = knownIdsJson;
    },
  };
  const persistence = new MemoryPersistence();
  persistence.notes = opts.local ?? [];
  const store = new NoteStore(persistence, 5);
  const transport = new FakeTransport(
    opts.remote
      ? encodeSnapshot({ ...opts.remote, attachments: opts.attachments ?? opts.remote.attachments })
      : null,
  );
  const manager = new SyncManager({
    store,
    settings: () => settings,
    sink,
    clientFactory: () => transport,
    now: () => 10_000,
  });
  await store.loadInitial();
  return { store, transport, settings, manager, persistence };
}

test("first sync pushes the local snapshot; a no-op sync does not push again", async () => {
  const { store, transport, manager } = await setup({ local: [note("n1", 1000)] });
  const first = await manager.sync("manual");
  assert.equal(first.kind, "ok");
  assert.equal(transport.pushed, 1);
  assert.equal(decodeSnapshot(transport.json!).notes.length, 1);
  const second = await manager.sync("manual");
  assert.equal(second.kind, "ok");
  assert.equal(transport.pushed, 1, "identical payload must not be re-pushed");
});

test("local deletions become tombstones that beat the remote modified time", async () => {
  const { store, transport, manager } = await setup({ local: [note("n1", 1000)] });
  await manager.sync();
  await store.delete("n1");
  await new Promise((r) => setTimeout(r, 12));
  await manager.sync();
  const pushed = decodeSnapshot(transport.json!);
  assert.ok(pushed.deleted.n1 > 1000);
  assert.equal(pushed.notes.length, 0);
});

test("download-only applies remote notes and never pushes", async () => {
  const { store, transport, manager } = await setup({
    settings: { syncMode: SYNC_MODE_DOWNLOAD },
    remote: { updated: 1, notes: [note("remote", 2000)], deleted: {}, attachments: {} },
  });
  const result = await manager.sync();
  assert.equal(result.kind, "ok");
  assert.equal(store.note("remote")?.body, "body remote");
  assert.equal(transport.pushed, 0);
});

test("remote deletions are applied unless the policy says remote_off", async () => {
  const { store, manager } = await setup({
    local: [note("n1", 1000), note("n2", 1000)],
    remote: {
      updated: 1,
      notes: [],
      deleted: { n1: 2000 },
      attachments: {},
    },
  });
  await manager.sync();
  assert.equal(store.note("n1"), undefined);
  assert.ok(store.note("n2"));
});

test("local_off keeps remote notes in the shared file but never resurrects them", async () => {
  const { store, transport, manager } = await setup({
    local: [note("n1", 1000)],
    settings: { syncDeletion: SYNC_DELETION_LOCAL_OFF },
  });
  await manager.sync();
  await store.delete("n1");
  await new Promise((r) => setTimeout(r, 12));
  await manager.sync();
  const pushed = decodeSnapshot(transport.json!);
  assert.equal(pushed.deleted.n1, undefined);
  assert.equal(store.note("n1"), undefined);
});

test("a note won locally keeps the remote attachment metadata", async () => {
  const att: Attachment = {
    id: "att-1",
    noteId: "n1",
    kind: "image",
    mime: "image/png",
    fileName: "a.png",
    size: 1,
    sha256: "",
    extractedText: "",
    aiSummary: "",
    parseStatus: "ready",
  };
  const { store, transport, manager } = await setup({
    local: [note("n1", 5000)],
    remote: { updated: 1, notes: [note("n1", 1000)], deleted: {}, attachments: {} },
    attachments: { n1: [att] },
  });
  await manager.sync();
  const pushed = decodeSnapshot(transport.json!);
  assert.equal(pushed.attachments.n1[0].id, "att-1");
  assert.equal(store.note("n1")?.modified, 5000);
});

test("not configured is reported without touching the transport", async () => {
  const { manager } = await setup({ settings: { webdavUrl: "" } });
  const result = await manager.sync();
  assert.equal(result.kind, "not_configured");
});
