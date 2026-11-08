import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync, zipSync } from "fflate";
import {
  ATTACHMENTS_DIR,
  attachmentEntryName,
  looksLikeZip,
  makeBackupZip,
  NOTES_ENTRY,
  parseBackupZip,
  sha256Hex,
} from "./backupZip.ts";
import { makeBackup } from "./backup.ts";
import { emptySettings, emptyWikiState } from "./types.ts";
import type { Attachment, Note, WikiPage } from "./types.ts";
import type { ChatSession } from "./chat/types.ts";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  title: "First",
  body: "first body",
  color: 2,
  created: 1000,
  modified: 2000,
  archived: false,
  pinned: false,
  order: 0,
  ...over,
});

const attachment = (over: Partial<Attachment> & { id: string }): Attachment => ({
  noteId: "n1",
  kind: "image",
  mime: "image/png",
  fileName: "photo.png",
  size: 5,
  sha256: "",
  extractedText: "",
  aiSummary: "",
  parseStatus: "ok",
  ...over,
});

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

const chat: ChatSession[] = [
  {
    id: "c1",
    title: "Hi",
    messages: [{ role: "user", content: "yo", at: 5 }],
    updatedAt: 4,
  },
];

const settings = [
  { key: "webdavPass", type: "string", value: "secret" },
  { key: "wikiAutoCompile", type: "boolean", value: "true" },
];

const bytesA = new Uint8Array([1, 2, 3, 4, 5]);
const bytesB = new TextEncoder().encode("hello attachment");

function fixtureInput() {
  const attA = attachment({ id: "att-1", sha256: sha256(bytesA), size: bytesA.length });
  const attB = attachment({
    id: "att-2",
    noteId: "n2",
    kind: "document",
    mime: "text/plain",
    fileName: "notes.txt",
    sha256: sha256(bytesB),
    size: bytesB.length,
    parseStatus: "pending",
  });
  return {
    input: {
      notes: [
        note({
          document: {
            schemaVersion: 1,
            blocks: [{ type: "paragraph", id: "b1", text: "first body" }],
          },
        }),
        note({ id: "n2", title: "Second", body: "second body", archived: true, order: 1 }),
      ],
      settings,
      pages,
      state: { ...emptyWikiState(), noteHashes: { n1: "h1" } },
      chat,
      attachments: [
        { meta: attA, bytes: bytesA },
        { meta: attB, bytes: bytesB },
      ],
      now: NOW,
    },
    attA,
    attB,
  };
}

test("zip round-trip preserves notes, extras and attachment bytes", () => {
  const { input, attA } = fixtureInput();
  const zip = makeBackupZip(input);
  assert.ok(looksLikeZip(zip));

  // Entry names match the Android/macOS layout exactly.
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries).sort(), [
    "attachments/att-1_photo.png",
    "attachments/att-2_notes.txt",
    "chat.json",
    "notes.json",
    "settings.json",
    "wiki.json",
  ].sort());

  // notes.json is the stickies archive: app "Noty", whole-second UTC stamps,
  // ZipNote field set exactly (no platform extras like pinned).
  const notesJson = JSON.parse(strFromU8(entries[NOTES_ENTRY]));
  assert.equal(notesJson.app, "Noty");
  assert.equal(notesJson.version, 1);
  assert.equal(notesJson.exported, "2026-11-05T12:00:00Z");
  assert.equal(notesJson.notes.length, 2);
  assert.deepEqual(Object.keys(notesJson.notes[0]).sort(), [
    "archived",
    "attachments",
    "body",
    "color",
    "colorName",
    "created",
    "document",
    "id",
    "modified",
    "order",
    "title",
  ]);
  assert.equal(notesJson.notes[0].colorName, "Rose"); // color 2 per Android palette
  assert.equal(notesJson.notes[0].created, "1970-01-01T00:00:01Z");
  assert.deepEqual(notesJson.notes[0].attachments, [
    {
      id: "att-1",
      kind: "image",
      mime: "image/png",
      fileName: "photo.png",
      size: 5,
      sha256: sha256(bytesA),
      extractedText: "",
      aiSummary: "",
      parseStatus: "ok",
    },
  ]);
  // settings.json is a bare pref array (Android BackupPrefsCodec shape).
  assert.ok(Array.isArray(JSON.parse(strFromU8(entries["settings.json"]))));

  const back = parseBackupZip(zip);
  assert.equal(back.format, "zip");
  assert.deepEqual(back.failures, []);
  assert.equal(back.notes.length, 2);
  assert.equal(back.notes[0].id, "n1");
  assert.equal(back.notes[0].body, "first body");
  assert.equal(back.notes[0].color, 2);
  assert.equal(back.notes[0].created, 1000);
  assert.equal(back.notes[0].modified, 2000);
  assert.equal(back.notes[0].document?.blocks.length, 1);
  assert.equal(back.notes[1].archived, true);
  assert.deepEqual(back.settings, settings);
  assert.deepEqual(back.wiki, {
    pages,
    state: { ...emptyWikiState(), noteHashes: { n1: "h1" } },
  });
  assert.deepEqual(back.chat, chat);

  assert.equal(back.attachments.length, 2);
  const gotA = back.attachments.find((a) => a.meta.id === "att-1");
  assert.ok(gotA);
  assert.deepEqual(gotA.bytes, bytesA);
  assert.equal(gotA.meta.noteId, "n1");
  assert.equal(gotA.meta.sha256, attA.sha256);
  const gotB = back.attachments.find((a) => a.meta.id === "att-2");
  assert.ok(gotB);
  assert.deepEqual(gotB.bytes, bytesB);
});

test("corrupted attachment payload fails per item, rest applies", () => {
  const { input, attA } = fixtureInput();
  const entries = unzipSync(makeBackupZip(input));
  const corrupt = new Uint8Array(entries[`${ATTACHMENTS_DIR}att-1_photo.png`]);
  corrupt[1] ^= 0xff;
  entries[`${ATTACHMENTS_DIR}att-1_photo.png`] = corrupt;
  const tampered = zipSync(entries);

  const back = parseBackupZip(tampered);
  assert.equal(back.failures.length, 1);
  assert.equal(back.failures[0].name, attA.fileName);
  assert.match(back.failures[0].reason, /sha256 mismatch/);

  // The corrupt payload is isolated: notes and the healthy attachment apply.
  assert.equal(back.notes.length, 2);
  assert.equal(back.attachments.length, 2);
  const bad = back.attachments.find((a) => a.meta.id === "att-1");
  assert.ok(bad);
  assert.equal(bad.bytes, null);
  const good = back.attachments.find((a) => a.meta.id === "att-2");
  assert.ok(good);
  assert.deepEqual(good.bytes, bytesB);
});

test("missing payloads and absent extras are tolerated", () => {
  const { input, attA } = fixtureInput();
  const zip = makeBackupZip({
    ...input,
    attachments: [{ meta: attA, bytes: null }],
    settings: undefined,
    pages: undefined,
    state: undefined,
    chat: undefined,
  });
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries), ["notes.json"]);

  const back = parseBackupZip(zip);
  assert.equal(back.format, "zip");
  assert.equal(back.notes.length, 2);
  assert.deepEqual(back.failures, [
    { name: attA.fileName, reason: "payload file missing in zip" },
  ]);
  // Metadata still travels so the attachment shows as not-downloaded.
  assert.deepEqual(back.attachments, [{ meta: attA, bytes: null }]);
  assert.equal(back.wiki, null);
  assert.equal(back.chat, null);
  assert.deepEqual(back.settings, []);
});

test("corrupt wiki.json is a per-item failure, not a rejected archive", () => {
  const { input } = fixtureInput();
  const entries = unzipSync(makeBackupZip(input));
  entries["wiki.json"] = new TextEncoder().encode("{not json");
  const back = parseBackupZip(zipSync(entries));
  assert.equal(back.wiki, null);
  assert.deepEqual(
    back.failures.map((f) => f.name),
    ["wiki.json"],
  );
  assert.equal(back.notes.length, 2);
});

test("legacy single-JSON backup still parses", () => {
  const { input, attA } = fixtureInput();
  const legacy = JSON.stringify(
    makeBackup(
      input.notes,
      { ...emptySettings(), webdavPass: "legacy-secret" },
      input.pages!,
      input.state!,
      input.chat!,
      [{ meta: attA, bytes: bytesA }],
    ),
  );
  assert.equal(looksLikeZip(new TextEncoder().encode(legacy)), false);

  const back = parseBackupZip(new TextEncoder().encode(legacy));
  assert.equal(back.format, "legacy-json");
  assert.equal(back.notes.length, 2);
  assert.equal(back.legacySettings?.webdavPass, "legacy-secret");
  assert.deepEqual(back.wiki, { pages, state: input.state });
  assert.deepEqual(back.chat, chat);
  assert.equal(back.attachments.length, 1);
  assert.deepEqual(back.attachments[0].bytes, bytesA);
  assert.deepEqual(back.failures, []);
});

test("looksLikeZip only accepts the PK header", () => {
  assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), true);
  assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), false);
  assert.equal(looksLikeZip(new TextEncoder().encode("{}")), false);
  assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b])), false);
});

test("attachment entry names sanitize illegal characters like Android", () => {
  const base = attachment({ id: "att-9" });
  assert.equal(
    attachmentEntryName({ ...base, fileName: "a/b\\c:d?e*f\"g<h>i|j.png" }),
    `${ATTACHMENTS_DIR}att-9_a-b-c-d-e-f-g-h-i-j.png`,
  );
  assert.equal(
    attachmentEntryName({ ...base, fileName: "  " }),
    `${ATTACHMENTS_DIR}att-9_payload`,
  );
  assert.equal(
    attachmentEntryName({ ...base, fileName: "照片.png" }),
    `${ATTACHMENTS_DIR}att-9_照片.png`,
  );
});

test("foreign notes.json inside a zip is a file-level rejection", () => {
  const zip = zipSync({ [NOTES_ENTRY]: new TextEncoder().encode("[]") });
  assert.throws(() => parseBackupZip(zip), /not a NoneNote backup/);
  const zipNoNotes = zipSync({ "other.txt": new TextEncoder().encode("x") });
  assert.throws(() => parseBackupZip(zipNoNotes), /notes\.json missing/);
});

test("sha256Hex matches node:crypto", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 7 + len) % 256);
    assert.equal(sha256Hex(bytes), sha256(bytes));
  }
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
