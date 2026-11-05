import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSnapshot, encodeSnapshot } from "./codec.ts";
import type { Note, SyncSnapshot } from "../types.ts";

const note: Note = {
  id: "uuid-1",
  title: "t",
  body: "明文 body",
  color: 3,
  created: 1_788_000_000_000,
  modified: 1_789_000_000_000,
  archived: true,
  pinned: true,
  order: -2.5,
  document: null,
};

const sample: SyncSnapshot = {
  updated: 1_789_000_000_000,
  notes: [note],
  deleted: { "uuid-2": 1_789_500_000_000 },
  attachments: {
    "uuid-1": [
      {
        id: "att-1",
        noteId: "uuid-1",
        kind: "image",
        mime: "image/png",
        fileName: "a.png",
        size: 10,
        sha256: "abc",
        extractedText: "text",
        aiSummary: "summary",
        parseStatus: "ready",
      },
    ],
  },
};

test("codec round-trips notes, tombstones and attachment metadata", () => {
  const back = decodeSnapshot(encodeSnapshot(sample));
  assert.equal(back.updated, sample.updated);
  assert.deepEqual(back.deleted, sample.deleted);
  assert.equal(back.notes.length, 1);
  const n = back.notes[0];
  assert.equal(n.id, "uuid-1");
  assert.equal(n.body, "明文 body");
  assert.equal(n.color, 3);
  assert.equal(n.archived, true);
  assert.equal(n.pinned, true);
  assert.equal(n.order, -2.5);
  assert.equal(back.attachments["uuid-1"][0].kind, "image");
  assert.equal(back.attachments["uuid-1"][0].aiSummary, "summary");
});

test("codec writes the pinned schema fields and whole-second stamps", () => {
  const root = JSON.parse(encodeSnapshot(sample)) as Record<string, unknown>;
  assert.equal(root.app, "NoneNote");
  assert.equal(root.version, 1);
  assert.equal(root.updated, "2026-09-10T00:26:40Z");
  const noteJson = JSON.stringify((root.notes as unknown[])[0]);
  for (const field of ["id", "title", "body", "color", "created", "modified", "archived", "pinned", "order"]) {
    assert.ok(noteJson.includes(`"${field}"`), `missing ${field}`);
  }
  assert.ok(JSON.stringify(root.deleted).includes("deletedAt"));
});

test("codec keeps the block document and projects its body", () => {
  const withDoc: Note = {
    ...note,
    document: {
      schemaVersion: 1,
      blocks: [
        { type: "paragraph", id: "b1", text: "hi" },
        { type: "image", id: "b2", attachmentId: "att-1", alt: "a" },
      ],
    },
    body: "stale body",
  };
  const text = encodeSnapshot({ ...sample, notes: [withDoc], attachments: {} });
  assert.ok(text.includes('"document"'));
  const back = decodeSnapshot(text).notes[0];
  assert.equal(back.document?.blocks.length, 2);
  assert.match(back.body, /hi/);
  assert.match(back.body, /attachment:att-1/);
});

test("codec decodes the design-doc sample and ignores unknown keys", () => {
  const text = JSON.stringify({
    app: "NoneNote",
    version: 1,
    updated: "2026-08-31T08:00:00Z",
    futureField: [1, 2],
    notes: [
      {
        order: 1.5,
        pinned: true,
        archived: false,
        modified: "2026-08-31T08:00:00Z",
        created: "2026-08-30T08:00:00Z",
        body: "明文",
        title: "",
        id: "uuid",
        color: 0,
      },
    ],
    deleted: [{ id: "uuid-gone", deletedAt: "2026-08-31T09:00:00Z" }],
  });
  const snap = decodeSnapshot(text);
  assert.equal(snap.notes[0].id, "uuid");
  assert.equal(snap.notes[0].pinned, true);
  assert.equal(snap.deleted["uuid-gone"], Date.parse("2026-08-31T09:00:00Z"));
});

test("decode throws on unparseable timestamps instead of silently zeroing", () => {
  const text = JSON.stringify({
    updated: "not-a-date",
    notes: [],
    deleted: [],
  });
  assert.throws(() => decodeSnapshot(text), /Unparseable ISO timestamp/);
});
