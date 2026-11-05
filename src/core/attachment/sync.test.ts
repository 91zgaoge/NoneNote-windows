import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AttachmentSync } from "./sync.ts";
import { AttachmentStore } from "./store.ts";
import { cipheredSize, sha256HexBytes } from "./crypto.ts";
import { WebDavClient } from "../sync/webdav.ts";
import type { HttpTransport } from "../http.ts";
import type { StorageAdapter } from "../../platform/storage.ts";
import type { BlobStore } from "../../platform/blobStore.ts";
import type { AppSettings, Attachment } from "../types.ts";
import { emptySettings } from "../types.ts";

class MemoryStorage implements StorageAdapter {
  map = new Map<string, string>();
  async load<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async save(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class MemoryBlobs implements BlobStore {
  map = new Map<string, Uint8Array>();
  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
  }
  async read(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const fetchTransport: HttpTransport = {
  async request(req) {
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.bodyBase64 ? Buffer.from(req.bodyBase64, "base64") : req.body,
    });
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: resp.status,
      headers,
      body: new TextDecoder().decode(bytes),
      bodyBase64: Buffer.from(bytes).toString("base64"),
    };
  },
};

class FakeDav {
  files = new Map<string, Uint8Array>();
  server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const existing = this.files.get(path);
        if (req.method === "PROPFIND") {
          res.writeHead(207);
          res.end();
        } else if (req.method === "MKCOL") {
          if (existing) res.writeHead(405);
          else {
            this.files.set(path, new Uint8Array(0));
            res.writeHead(201);
          }
          res.end();
        } else if (req.method === "HEAD") {
          if (!existing) {
            res.writeHead(404);
            res.end();
          } else {
            res.writeHead(200, { "Content-Length": String(existing.length) });
            res.end();
          }
        } else if (req.method === "GET") {
          if (!existing) {
            res.writeHead(404);
            res.end();
          } else {
            res.writeHead(200);
            res.end(Buffer.from(existing));
          }
        } else if (req.method === "PUT") {
          this.files.set(path, new Uint8Array(body));
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
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/dav`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function settings(url: string, pass = "dav-pass"): AppSettings {
  return { ...emptySettings(), webdavUrl: url, webdavUser: "u", webdavPass: pass };
}

function store(): AttachmentStore {
  return new AttachmentStore(new MemoryStorage(), new MemoryBlobs());
}

function syncFor(s: AttachmentStore, url: string) {
  return new AttachmentSync(
    s,
    (cfg) => new WebDavClient(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, fetchTransport),
  );
}

test("attachments upload one side and download on the other", async () => {
  const dav = new FakeDav();
  await dav.start();
  try {
    const plain = new TextEncoder().encode("hello attachment payload");
    const meta: Attachment = {
      id: "att-1",
      noteId: "n1",
      kind: "document",
      mime: "text/plain",
      fileName: "a.txt",
      size: plain.length,
      sha256: await sha256HexBytes(plain),
      extractedText: "",
      aiSummary: "",
      parseStatus: "pending",
    };
    const merged = { updated: 0, notes: [], deleted: {}, attachments: { n1: [meta] } };

    const a = store();
    await a.savePayload(meta, plain);
    const up = await syncFor(a, dav.url).sync(merged, settings(dav.url));
    assert.equal(up.uploaded, 1);
    assert.equal(up.failed, 0);
    const remote = dav.files.get("/dav/NoneNote/attachments/att-1")!;
    assert.ok(remote.length > 0);
    assert.equal(remote.length, cipheredSize(plain.length));
    assert.equal(new TextDecoder().decode(remote).includes("hello attachment"), false);

    const b = store();
    const down = await syncFor(b, dav.url).sync(merged, settings(dav.url));
    assert.equal(down.downloaded, 1);
    assert.equal(down.failed, 0);
    assert.deepEqual(await b.payload("att-1"), plain);
    assert.equal((await b.get("att-1"))?.hasPayload, true);

    // Both sides are now in sync; a second pass does no transfers.
    assert.equal((await syncFor(a, dav.url).sync(merged, settings(dav.url))).uploaded, 0);
    assert.equal((await syncFor(b, dav.url).sync(merged, settings(dav.url))).downloaded, 0);
  } finally {
    await dav.stop();
  }
});

test("a wrong WebDAV password fails the download without storing anything", async () => {
  const dav = new FakeDav();
  await dav.start();
  try {
    const plain = new TextEncoder().encode("secret bytes");
    const meta: Attachment = {
      id: "att-2",
      noteId: "n1",
      kind: "document",
      mime: "text/plain",
      fileName: "b.txt",
      size: plain.length,
      sha256: await sha256HexBytes(plain),
      extractedText: "",
      aiSummary: "",
      parseStatus: "pending",
    };
    const merged = { updated: 0, notes: [], deleted: {}, attachments: { n1: [meta] } };
    const a = store();
    await a.savePayload(meta, plain);
    await syncFor(a, dav.url).sync(merged, settings(dav.url));

    const b = store();
    const out = await syncFor(b, dav.url).sync(merged, settings(dav.url, "wrong"));
    assert.equal(out.failed, 1);
    assert.equal(await b.payload("att-2"), null);
  } finally {
    await dav.stop();
  }
});
