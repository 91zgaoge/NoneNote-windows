import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFacts, isExpired, memoryHash, planMemory, type FactView } from "./ops.ts";
import type { MemoryFact } from "./types.ts";
import { sha256Sync } from "../wiki/text.ts";

function view(id: string, fact: string, extra: Partial<FactView> = {}): FactView {
  return {
    id,
    fact,
    kind: "static",
    relation: "add",
    isLatest: true,
    isInference: false,
    contentHash: memoryHash(fact),
    ...extra,
  };
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

test("memoryHash normalizes case and whitespace", () => {
  assert.equal(memoryHash("  Likes   TEA "), memoryHash("likes tea"));
  assert.equal(memoryHash("Likes tea"), sha256Sync("likes tea"));
});

test("expiry compares ISO dates and expires the day after", () => {
  assert.equal(isExpired("2026-11-05", "2026-11-05"), false);
  assert.equal(isExpired("2026-11-04", "2026-11-05"), true);
  assert.equal(isExpired(null, "2026-11-05"), false);
});

test("plan folds add/updates/extends/derives and dedups by hash", () => {
  const existing = [view("f1", "Likes tea")];
  const plan = planMemory(
    existing,
    [
      { fact: "Likes tea", kind: "static", relation: "add" },
      { fact: "Likes green tea", kind: "static", relation: "updates", targetId: "f1" },
      { fact: "Drinks tea daily", kind: "dynamic", relation: "extends", targetId: "f1" },
      { fact: "Probably works remotely", kind: "static", relation: "derives" },
      { fact: "Bad relation", kind: "nonsense", relation: "nonsense" },
    ],
    (() => {
      let i = 0;
      return () => `new-${++i}`;
    })(),
  );
  assert.equal(plan.inserts.length, 4);
  assert.deepEqual(plan.incrementIds, ["f1"]);
  assert.deepEqual(plan.supersedeIds, ["f1"]);
  const update = plan.inserts[0];
  assert.equal(update.parentId, "f1");
  assert.equal(update.rootId, "f1");
  assert.equal(plan.inserts[1].relation, "extends");
  assert.equal(plan.inserts[2].isInference, true);
  assert.equal(plan.inserts[3].kind, "dynamic"); // invalid kind falls back
  assert.equal(plan.inserts[3].relation, "add"); // invalid relation falls back
});

test("updates/extends without a target degrade to add", () => {
  const plan = planMemory([], [
    { fact: "A", relation: "updates", targetId: "missing" },
    { fact: "B", relation: "extends" },
  ]);
  assert.equal(plan.inserts[0].relation, "add");
  assert.equal(plan.inserts[1].relation, "add");
});

test("invalid forgetAfter is dropped and activeFacts filters all dead rows", () => {
  const plan = planMemory([], [{ fact: "Temporary", forgetAfter: "soon" }]);
  assert.equal(plan.inserts[0].forgetAfter, null);
  const today = "2026-11-05";
  const facts = [
    fact("a", "live", { kind: "dynamic" }),
    fact("b", "expired", { forgetAfter: "2026-11-04" }),
    fact("c", "forgotten", { forgotten: true }),
    fact("d", "old version", { isLatest: false }),
  ];
  assert.deepEqual(activeFacts(facts, today).map((f) => f.id), ["a"]);
});
