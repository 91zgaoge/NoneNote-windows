import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedTitle, isoStamp, parseIso, notePreview, taskProgress } from "./text.ts";
import type { Note } from "./types.ts";

test("derivedTitle strips heading/task markers and image-only lines", () => {
  assert.equal(derivedTitle("## Hello world\nbody"), "Hello world");
  assert.equal(derivedTitle("![img](attachment:x)\n- [ ] Buy milk"), "Buy milk");
  assert.equal(derivedTitle("☑ Ship release"), "Ship release");
  assert.equal(derivedTitle(""), "");
  assert.equal(derivedTitle("x".repeat(80)).length, 61);
});

test("isoStamp writes whole-second UTC and parseIso accepts variants", () => {
  assert.equal(isoStamp(1_789_000_000_999), "2026-09-10T00:26:40Z");
  assert.equal(parseIso("2026-09-10T00:26:40Z"), 1_789_000_000_000);
  assert.equal(parseIso("2026-09-10T00:26:40.999Z"), 1_789_000_000_999);
  assert.equal(parseIso("2026-09-10T02:26:40+02:00"), 1_789_000_000_000);
  assert.throws(() => parseIso("not a date"));
});

test("notePreview and taskProgress ignore the title line", () => {
  const n: Note = {
    id: "n",
    title: "T",
    body: "Title\n- [ ] one\n- [x] two",
    color: 0,
    created: 0,
    modified: 0,
    archived: false,
    pinned: false,
    order: 0,
  };
  assert.equal(notePreview(n), "- [ ] one - [x] two");
  assert.deepEqual(taskProgress(n), [1, 2]);
});
