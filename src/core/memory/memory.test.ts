import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./store.ts";
import { MemoryDreamer } from "./dreamer.ts";
import { memoryHash } from "./ops.ts";
import type { MemoryFact } from "./types.ts";
import type { StorageAdapter } from "../../platform/storage.ts";
import type { LlmClient, LlmUsage } from "../ai/client.ts";
import type { Note } from "../types.ts";

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

function fact(id: string, text: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    fact: text,
    kind: "static",
    relation: "add",
    isLatest: true,
    isInference: false,
    sourceNoteIds: "[]",
    forgotten: false,
    sourceCount: 1,
    createdAt: 1,
    updatedAt: 1,
    contentHash: memoryHash(text),
    ...extra,
  };
}

function note(id: string, body: string): Note {
  return {
    id,
    title: id,
    body,
    color: 0,
    created: 1,
    modified: 1,
    archived: false,
    pinned: false,
    order: 0,
  };
}

class FakeLlm implements LlmClient {
  calls = 0;
  answer = "[]";
  async chat(): Promise<string> {
    this.calls++;
    return this.answer;
  }
  async chatWithUsage(): Promise<[string, LlmUsage]> {
    return [await this.chat(), { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }];
  }
}

test("store expires, forgets, approves and prunes facts", async () => {
  const store = new MemoryStore(new MemoryStorage());
  const today = "2026-11-05";
  await store.upsert(fact("live", "Likes tea"));
  await store.upsert(fact("expired", "Old plan", { forgetAfter: "2026-11-04" }));
  await store.upsert(fact("inferred", "Probably remote", { isInference: true }));

  assert.deepEqual((await store.active(today)).map((f) => f.id), ["live", "inferred"]);
  assert.equal(await store.expireBefore(today, 10), 1);
  assert.equal((await store.visible()).some((f) => f.id === "expired"), false);

  await store.softForget("live", "declined", 20);
  assert.deepEqual((await store.active(today)).map((f) => f.id), ["inferred"]);

  await store.approve("inferred", 30);
  assert.equal((await store.inferred()).length, 0);
  assert.equal((await store.byId("inferred"))?.isInference, false);

  assert.equal(await store.pruneForgotten(100), 2);
});

test("dreamer extracts incrementally, supersedes and retries after a parse failure", async () => {
  const store = new MemoryStore(new MemoryStorage());
  const llm = new FakeLlm();
  let ids = 0;
  let notes = [note("n1", "I like tea")];
  const dreamer = new MemoryDreamer({
    store,
    notes: () => notes,
    llmFactory: () => llm,
    now: () => 1000,
    today: () => "2026-11-05",
    idGen: () => `f${++ids}`,
  });

  llm.answer = "garbage";
  assert.equal(await dreamer.dream(), null);
  assert.equal((await store.visible()).length, 0);
  assert.deepEqual((await store.loadState()).noteHashes, {});

  llm.answer = JSON.stringify([{ fact: "Likes tea", kind: "static", relation: "add" }]);
  const first = await dreamer.dream();
  assert.equal(first?.inserted, 1);
  const active = await store.active("2026-11-05");
  assert.equal(active.length, 1);
  assert.equal(active[0].fact, "Likes tea");

  const callsAfterFirst = llm.calls;
  const again = await dreamer.dream();
  assert.deepEqual(again, { inserted: 0, superseded: 0, corroborated: 0, expired: 0 });
  assert.equal(llm.calls, callsAfterFirst);

  notes = [note("n1", "I like green tea now")];
  llm.answer = JSON.stringify([
    { fact: "Likes green tea", kind: "static", relation: "updates", targetId: "f1" },
  ]);
  const second = await dreamer.dream();
  assert.equal(second?.inserted, 1);
  assert.equal(second?.superseded, 1);
  const heads = await store.active("2026-11-05");
  assert.equal(heads.length, 1);
  assert.equal(heads[0].fact, "Likes green tea");
  assert.equal(heads[0].parentId, "f1");
  assert.equal((await store.byId("f1"))?.isLatest, false);
});

test("dreamer remembers each conversation line exactly once", async () => {
  const store = new MemoryStore(new MemoryStorage());
  const llm = new FakeLlm();
  const lines = [{ id: "c1", text: "user: I moved to Shanghai" }];
  const dreamer = new MemoryDreamer({
    store,
    notes: () => [],
    conversation: () => lines,
    llmFactory: () => llm,
    now: () => 1000,
    today: () => "2026-11-05",
    idGen: () => "f1",
  });
  llm.answer = JSON.stringify([{ fact: "Lives in Shanghai", kind: "static", relation: "add" }]);
  assert.equal((await dreamer.dream())?.inserted, 1);
  assert.equal(llm.calls, 1);
  assert.deepEqual((await store.loadState()).chatIds, ["c1"]);
  assert.equal((await dreamer.dream())?.inserted, 0);
  assert.equal(llm.calls, 1);
});
