import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryHash } from "./ops.ts";
import {
  DYNAMIC_CAP,
  INFERRED_CAP,
  STATIC_CAP,
  formatProfile,
  questionTerms,
  synthesizeProfile,
} from "./profile.ts";
import type { MemoryFact } from "./types.ts";

const NOW = 1_790_000_000_000;
const DAY = 24 * 3600 * 1000;

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
    createdAt: NOW,
    updatedAt: NOW,
    contentHash: memoryHash(text),
    ...extra,
  };
}

test("static facts rank by corroboration and are capped", () => {
  const facts = [
    fact("a", "Likes tea", { sourceCount: 1 }),
    fact("b", "Lives in Shanghai", { sourceCount: 5 }),
    ...Array.from({ length: STATIC_CAP + 3 }, (_, i) =>
      fact(`x${i}`, `Extra ${i}`, { sourceCount: 2 }),
    ),
  ];
  const profile = synthesizeProfile(facts, NOW, "2026-11-05");
  assert.equal(profile.staticFacts[0], "Lives in Shanghai");
  assert.equal(profile.staticFacts.length, STATIC_CAP);
  assert.equal(profile.staticFacts.includes("Likes tea"), false);
});

test("dynamic facts need freshness and carry a date prefix", () => {
  const facts = [
    fact("fresh", "Preparing a trip", {
      kind: "dynamic",
      updatedAt: NOW - 2 * DAY,
    }),
    fact("stale", "Old state", { kind: "dynamic", updatedAt: NOW - 20 * DAY }),
    ...Array.from({ length: DYNAMIC_CAP + 2 }, (_, i) =>
      fact(`d${i}`, `Recent ${i}`, { kind: "dynamic", updatedAt: NOW - i * 1000 }),
    ),
  ];
  const profile = synthesizeProfile(facts, NOW, "2026-11-05a");
  assert.equal(profile.dynamicFacts.length, DYNAMIC_CAP);
  assert.equal(profile.dynamicFacts.includes("Old state"), false);
  assert.match(profile.dynamicFacts[0], /^\(\d{4}-\d{2}-\d{2}\) /);
});

test("inferred facts only appear when the question matches, capped", () => {
  const facts = [
    fact("i1", "Probably works remotely", { relation: "derives", isInference: true }),
    fact("i2", "Probably likes running", { relation: "derives", isInference: true }),
    fact("i3", "Probably likes coffee", { relation: "derives", isInference: true }),
  ];
  const none = synthesizeProfile(facts, NOW, "2026-11-05", "weather?");
  assert.deepEqual(none.inferred, []);
  const hit = synthesizeProfile(facts, NOW, "2026-11-05", "coffee?");
  assert.equal(hit.inferred.length, 1);
  assert.match(hit.inferred[0], /coffee.*\(inferred\)/);
  assert.equal(INFERRED_CAP, 2);
});

test("formatProfile caps the block and returns empty with no facts", () => {
  assert.equal(formatProfile({ staticFacts: [], dynamicFacts: [], inferred: [] }), "");
  const long = Array.from({ length: 50 }, (_, i) => `Fact ${i} ${"x".repeat(80)}`);
  const block = formatProfile({ staticFacts: long, dynamicFacts: [], inferred: [] }, 300);
  assert.ok(block.startsWith("About the user:"));
  assert.ok(block.length <= 300);
});

test("questionTerms takes latin words 3+ and CJK bigrams", () => {
  assert.deepEqual(questionTerms("Do I like 咖啡?"), ["like", "咖啡"]);
});
