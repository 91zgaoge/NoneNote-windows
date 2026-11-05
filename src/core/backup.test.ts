import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAttachmentPayload, makeBackup, parseBackup } from "./backup.ts";
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
  const chat = [{ id: "c1", title: "Hi", messages: [], updatedAt: 4 }];
  const attachment = {
    id: "att-1",
    noteId: "n1",
    kind: "image" as const,
    mime: "image/png",
    fileName: "a.png",
    size: 3,
    sha256: "abc",
    extractedText: "",
    aiSummary: "",
    parseStatus: "ok",
  };
  const text = JSON.stringify(
    makeBackup([note], settings, pages, state, chat, [
      { meta: attachment, bytes: new Uint8Array([1, 2, 3]) },
    ]),
  );
  assert.ok(text.includes("windows-backup"));
  const back = parseBackup(text);
  assert.equal(back.notes.length, 1);
  assert.equal(back.notes[0].id, "n1");
  assert.equal(back.notes[0].document?.blocks.length, 1);
  assert.equal(back.settings.webdavPass, "secret");
  assert.equal(back.pages[0].name, "Topic");
  assert.equal(back.state.noteHashes.n1, "abc");
  assert.equal(back.chat[0].id, "c1");
  assert.equal(back.attachments[0].meta.id, "att-1");
  assert.deepEqual(decodeAttachmentPayload(back.attachments[0]), new Uint8Array([1, 2, 3]));
});

test("foreign JSON is rejected", () => {
  assert.throws(() => parseBackup('{"app":"Other"}'), /not a NoneNote Windows backup/);
});
