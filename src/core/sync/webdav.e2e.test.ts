import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebDavClient } from "./webdav.ts";
import { SyncManager } from "./manager.ts";
import { decodeSnapshot } from "./codec.ts";
import type { HttpTransport } from "../http.ts";
import { NoteStore, type NotePersistence } from "../notes/store.ts";
import type { AppSettings, Note } from "../types.ts";
import { emptySettings } from "../types.ts";

/** Minimal in-memory WebDAV server: PROPFIND / MKCOL / GET / PUT. */
class FakeDav {
  files = new Map<string, string>();
  server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "PROPFIND") {
          res.writeHead(207, { "Content-Type": "application/xml" });
          res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
        } else if (req.method === "MKCOL") {
          if (this.files.has(path)) {
            res.writeHead(405);
          } else {
            this.files.set(path, "");
            res.writeHead(201);
          }
          res.end();
        } else if (req.method === "GET") {
          const value = this.files.get(path);
          if (value === undefined) {
            res.writeHead(404);
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(value);
          }
        } else if (req.method === "PUT") {
          this.files.set(path, body);
          res.writeHead(201);
          res.end();
        } else {
          res.writeHead(405);
          res.end();
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/dav`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const fetchTransport: HttpTransport = {
  async request(req) {
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: resp.status, headers, body: await resp.text() };
  },
};

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

function makeClient(url: string) {
  const settings: AppSettings = {
    ...emptySettings(),
    webdavUrl: url,
    webdavUser: "u",
    webdavPass: "p",
  };
  const persistence = new MemoryPersistence();
  const store = new NoteStore(persistence, 5);
  const manager = new SyncManager({
    store,
    settings: () => settings,
    sink: {
      async save(deletedJson, knownIdsJson) {
        settings.syncDeletedJson = deletedJson;
        settings.syncKnownIdsJson = knownIdsJson;
      },
    },
    clientFactory: (cfg) =>
      new WebDavClient(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, fetchTransport),
  });
  return { store, manager, settings, persistence };
}

test("two clients sync notes, edits and deletions over real HTTP", async () => {
  const dav = new FakeDav();
  await dav.start();
  try {
    const a = makeClient(dav.url);
    const b = makeClient(dav.url);
    const created = a.store.create("first body", 0, "First");
    await a.manager.sync("manual");
    assert.ok(dav.files.has("/dav/NoneNote/sync.json"));

    const pulled = await b.manager.sync("manual");
    assert.equal(pulled.kind, "ok");
    assert.equal(b.store.note(created.id)?.title, "First");

    const pulledNote = b.store.note(created.id)!;
    b.store.applyRemote({
      ...pulledNote,
      body: "second body",
      modified: pulledNote.modified + 2000,
    });
    await b.manager.sync("manual");
    await a.manager.sync("manual");
    assert.equal(a.store.note(created.id)?.body, "second body");

    a.store.delete(created.id);
    await new Promise((r) => setTimeout(r, 12));
    await a.manager.sync("manual");
    const remote = decodeSnapshot(dav.files.get("/dav/NoneNote/sync.json")!);
    assert.ok((remote.deleted[created.id] ?? 0) > 0);
    assert.equal(remote.notes.some((n) => n.id === created.id), false);

    await b.manager.sync("manual");
    assert.equal(b.store.note(created.id), undefined);
  } finally {
    await dav.stop();
  }
});

test("identical payloads are not re-pushed over HTTP", async () => {
  const dav = new FakeDav();
  await dav.start();
  try {
    const a = makeClient(dav.url);
    a.store.create("body", 0, "T");
    await a.manager.sync("manual");
    const before = dav.files.get("/dav/NoneNote/sync.json");
    await a.manager.sync("manual");
    assert.equal(dav.files.get("/dav/NoneNote/sync.json"), before);
  } finally {
    await dav.stop();
  }
});
