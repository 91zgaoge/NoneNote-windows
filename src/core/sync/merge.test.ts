import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "./merge.ts";
import type { Attachment, Note, SyncSnapshot } from "../types.ts";

function n(id: string, modified: number, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: id,
    body: id,
    color: 0,
    created: 0,
    modified,
    archived: false,
    pinned: false,
    order: 0,
    ...extra,
  };
}

function snap(notes: Note[], deleted: Record<string, number> = {}): SyncSnapshot {
  return { updated: 0, notes, deleted, attachments: {} };
}

test("merge is last-write-wins by modified, ties go to remote", () => {
  const local = [n("a", 10), n("b", 20)];
  const remote = snap([n("a", 11, { body: "remote-a" }), n("b", 20, { body: "remote-b" }), n("c", 5)]);
  const out = merge(local, {}, remote, 99);
  assert.equal(out.notes.find((x) => x.id === "a")?.body, "remote-a");
  assert.equal(out.notes.find((x) => x.id === "b")?.body, "remote-b");
  assert.equal(out.notes.find((x) => x.id === "c")?.body, "c");
  assert.equal(out.updated, 99);
});

test("tombstones newer than the note delete it; equal timestamps resurrect", () => {
  const local = [n("a", 10), n("b", 20)];
  const out = merge(local, { a: 11, b: 20 }, snap([n("a", 10), n("b", 20)]), 99);
  assert.deepEqual(out.notes.map((x) => x.id), ["b"]);
  assert.equal(out.deleted.a, 11);
});

test("local tombstones are unioned with remote and keep the latest", () => {
  const out = merge([], { a: 10, b: 30 }, snap([], { a: 20, c: 5 }), 99);
  assert.deepEqual(out.deleted, { a: 20, b: 30, c: 5 });
});

test("attachments follow the note's winning side", () => {
  const att = (id: string, noteId: string): Attachment => ({
    id,
    noteId,
    kind: "document",
    mime: "",
    fileName: id,
    size: 0,
    sha256: "",
    extractedText: "",
    aiSummary: "",
    parseStatus: "pending",
  });
  const local = [n("won-local", 30), n("won-remote", 10)];
  const remote: SyncSnapshot = {
    updated: 0,
    notes: [n("won-local", 20), n("won-remote", 11)],
    deleted: {},
    attachments: {
      "won-local": [att("remote-a", "won-local")],
      "won-remote": [att("remote-b", "won-remote")],
    },
  };
  const out = merge(local, {}, remote, 99, { "won-local": [att("local-a", "won-local")] });
  assert.equal(out.attachments["won-local"][0].id, "local-a");
  assert.equal(out.attachments["won-remote"][0].id, "remote-b");
});
