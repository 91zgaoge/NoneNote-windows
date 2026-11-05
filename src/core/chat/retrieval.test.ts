import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTokens, retrieve, renderContext } from "./retrieval.ts";
import type { Note, WikiPage } from "../types.ts";

function page(name: string, title: string, body: string): WikiPage {
  return { name, title, kind: "concept", body, sourceNoteIds: [], updatedAt: 1 };
}

function note(id: string, title: string, body: string): Note {
  return {
    id,
    title,
    body,
    color: 0,
    created: 1,
    modified: 1,
    archived: false,
    pinned: false,
    order: 0,
  };
}

test("queryTokens splits ASCII words and CJK bigrams", () => {
  assert.deepEqual(queryTokens("Kotlin coroutines 京都怎么去"), [
    "kotlin",
    "coroutines",
    "京都",
    "都怎",
    "怎么",
    "么去",
  ]);
});

test("pages rank above notes and unrelated material is dropped", () => {
  const chunks = retrieve(
    "how do coroutines work",
    [
      page("Coroutines", "Coroutines", "Structured concurrency with launch and async."),
      page("Japan", "Japan trip", "Kyoto and the shinkansen."),
    ],
    [note("n1", "Coroutine notes", "coroutines launch builder")],
  );
  assert.equal(chunks[0].kind, "page");
  assert.equal(chunks[0].name, "Coroutines");
  assert.ok(chunks.some((c) => c.kind === "note"));
  assert.equal(chunks.some((c) => c.name === "Japan trip"), false);
});

test("Chinese queries match CJK source text", () => {
  const chunks = retrieve(
    "京都怎么去",
    [page("Japan", "日本旅行", "从东京坐新干线去京都。")],
    [],
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].name, "日本旅行");
});

test("retrieval respects the total character budget", () => {
  const chunks = retrieve(
    "budget",
    [page("Big", "Budget", "budget " + "x".repeat(50_000))],
    [],
    { totalChars: 1_000, pageChars: 5_000 },
  );
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.length <= 1_000);
});

test("renderContext labels each chunk and keeps the material bounded", () => {
  const text = renderContext([
    { kind: "page", name: "A", text: "alpha", score: 2 },
    { kind: "note", name: "B", text: "beta", score: 1 },
  ]);
  assert.match(text, /--- wiki page: A ---/);
  assert.match(text, /--- note: B ---/);
});
