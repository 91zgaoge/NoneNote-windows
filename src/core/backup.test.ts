import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBackup, parseBackup } from "./backup.ts";
import { emptySettings } from "./types.ts";
import type { Note, WikiPage } from "./types.ts";
import { emptyWikiState } from "./types.ts";

const note: Note = {
  id: "n1",
  title: "T",
  body: "body",
  color: 2,
  created: 1,
  modified: 2,
  archived: false,
  pinned: true,
  order: -1,
  document: {
    schemaVersion: 1,
    blocks: [{ type: "paragraph", id: "b1", text: "body" }],
  },
};

test("backup round-trips notes, settings and the wiki", () => {
  const settings = { ...emptySettings(), webdavUrl: "https://dav.example", webdavPass: "secret" };
  const pages: WikiPage[] = [
    {
      name: "Topic",
      title: "Topic",
      kind: "concept",
      body: "# Topic",
      sourceNoteIds: ["n1"],
      updatedAt: 3,
    },
  ];
  const state = { ...emptyWikiState(), noteHashes: { n1: "abc" } };
  const text = JSON.stringify(makeBackup([note], settings, pages, state));
  assert.ok(text.includes("windows-backup"));
  const back = parseBackup(text);
  assert.equal(back.notes.length, 1);
  assert.equal(back.notes[0].id, "n1");
  assert.equal(back.notes[0].document?.blocks.length, 1);
  assert.equal(back.settings.webdavPass, "secret");
  assert.equal(back.pages[0].name, "Topic");
  assert.equal(back.state.noteHashes.n1, "abc");
});

test("foreign JSON is rejected", () => {
  assert.throws(() => parseBackup('{"app":"Other"}'), /not a NoneNote Windows backup/);
});
