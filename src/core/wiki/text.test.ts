import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Sync, slugify, wikilinks } from "./text.ts";

test("sha256Sync matches Node's SHA-256 for ASCII and CJK", () => {
  for (const text of ["", "abc", "你好，世界", "a".repeat(1000), "line\nline\n"]) {
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    assert.equal(sha256Sync(text), expected);
  }
});

test("slugify keeps letters/digits and collapses separators", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.equal(slugify("你好 世界"), "你好-世界");
  assert.equal(slugify("***"), "page");
});

test("wikilinks returns distinct targets in order", () => {
  assert.deepEqual(wikilinks("a [[One]] b [[Two]] c [[One]]"), ["One", "Two"]);
});
