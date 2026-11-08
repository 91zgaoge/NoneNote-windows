import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { encodeSnapshot, decodeSnapshot } from "./sync/codec.ts";
import { decodeAttachmentPayload, parseBackup } from "./backup.ts";
import { derivedTitle, isoStamp } from "./text.ts";
import { NOTE_COLOR_NAMES } from "./palette.ts";
import { emptyWikiState } from "./types.ts";
import type { AppSettings, Attachment, Note, WikiPage, WikiState } from "./types.ts";
import type { ChatSession } from "./chat/types.ts";

/**
 * Cross-platform ZIP backup — a port of Android's data/BackupZip.kt, matching
 * the macOS Sources/BackupZip.swift entry layout so archives are mutually
 * importable:
 *
 * - `notes.json` — the .stickies notes archive (app "Noty", whole-second UTC
 *   ISO stamps) extended with a per-note `attachments` metadata array; older
 *   importers ignore the unknown key.
 * - `attachments/<id>_<fileName>` — the DECRYPTED original bytes, plaintext
 *   (the user's own export; the at-rest store stays encrypted).
 * - `settings.json` — Android BackupPrefsCodec entries `[{key,type,value}]`;
 *   the caller maps AppSettings to/from these entries.
 * - `wiki.json` — `{version, pages, state}` so a restore skips recompiling.
 * - `chat.json` — `{version, sessions}` in this platform's ChatSession shape.
 *
 * The archive is PLAINTEXT and contains secrets: attachment originals, AI API
 * keys, WebDAV password. Anyone with the file can read everything — the UI
 * must warn before export (the existing warning stays) and the user must
 * store the archive safely and delete it when done.
 *
 * Import: the caller applies whole-archive replace semantics; here,
 * notes.json is file-level (missing/unparseable throws), while attachment
 * payloads and the three extras fail per item — a corrupt entry never aborts
 * the whole restore. Unknown entries are ignored and missing optional entries
 * are fine, so archives stay forward-compatible across platforms and
 * versions. The legacy single-JSON Windows backup (see backup.ts) is still
 * accepted.
 */

export const NOTES_ENTRY = "notes.json";
export const ATTACHMENTS_DIR = "attachments/";
export const SETTINGS_ENTRY = "settings.json";
export const WIKI_ENTRY = "wiki.json";
export const CHAT_ENTRY = "chat.json";

/** Extras are small; cap them so a hostile zip cannot exhaust memory. */
export const MAX_EXTRA_ENTRY_BYTES = 32 * 1024 * 1024;
/** Single attachment payload cap, mirroring Android AttachmentStore. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * One preference encoded for `settings.json`, byte-compatible with Android's
 * settings/BackupPrefsCodec.kt: `type` is the storage type (`boolean` / `int`
 * / `long` / `float` / `double` / `string` / `stringSet`), `value` its
 * textual form (`stringSet` carries a JSON array).
 */
export interface BackupPrefEntry {
  key: string;
  type: string;
  value: string;
}

export interface BackupAttachment {
  meta: Attachment;
  /** Decrypted payload; null when unavailable — metadata still travels. */
  bytes: Uint8Array | null;
}

export interface BackupZipInput {
  notes: Note[];
  /** settings.json entries (Android BackupPrefsCodec shape); omit to skip. */
  settings?: BackupPrefEntry[];
  pages?: WikiPage[];
  state?: WikiState;
  chat?: ChatSession[];
  attachments?: BackupAttachment[];
  /** Export timestamp; defaults to Date.now(). */
  now?: number;
}

/** One attachment/extra that could not be restored, with a presentable reason. */
export interface BackupImportFailure {
  name: string;
  reason: string;
}

export interface ParsedBackup {
  /** "zip" for the cross-platform archive, "legacy-json" for the old file. */
  format: "zip" | "legacy-json";
  notes: Note[];
  /** Attachment metadata plus verified plaintext bytes (null when failed). */
  attachments: { meta: Attachment; bytes: Uint8Array | null }[];
  /** Per-item failures; everything else applied normally. */
  failures: BackupImportFailure[];
  /** settings.json entries (Android shape); empty when absent or legacy. */
  settings: BackupPrefEntry[];
  /** Legacy single-JSON backup settings; null for zip archives. */
  legacySettings: Partial<AppSettings> | null;
  /** wiki.json content, or null when the entry is absent. */
  wiki: { pages: WikiPage[]; state: WikiState } | null;
  /** chat.json sessions, or null when the entry is absent. */
  chat: ChatSession[] | null;
}

// notes.json JSON shapes — field order mirrors Android's ZipArchive/ZipNote.

interface ZipAttachmentMetaJson {
  id: string;
  kind: string;
  mime: string;
  fileName: string;
  size: number;
  sha256: string;
  extractedText: string;
  aiSummary: string;
  /** Empty = written before status tracking; treated as pending downstream. */
  parseStatus: string;
}

interface ZipNoteJson {
  archived: boolean;
  attachments: ZipAttachmentMetaJson[];
  body: string;
  color: number;
  colorName: string;
  created: string;
  document?: Note["document"];
  id: string;
  modified: string;
  order: number;
  title: string;
}

interface ZipArchiveJson {
  app: string;
  exported: string;
  version: number;
  notes: ZipNoteJson[];
}

interface EncodedNoteJson {
  id: string;
  title: string;
  body: string;
  document?: Note["document"];
  color: number;
  created: string;
  modified: string;
  archived: boolean;
  order: number;
  attachments: ZipAttachmentMetaJson[];
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

const ILLEGAL_ENTRY_CHARS = /[/\\:*?"<>|\n\r\t]/g;

/** `attachments/<id>_<sanitised fileName>` — id stays matchable even if the
 * fileName was mangled (same rule as Android BackupZip.entryName). */
export function attachmentEntryName(a: Attachment): string {
  const name = a.fileName.replace(ILLEGAL_ENTRY_CHARS, "-").trim() || "payload";
  return `${ATTACHMENTS_DIR}${a.id}_${name}`;
}

export function makeBackupZip(input: BackupZipInput): Uint8Array {
  const now = input.now ?? Date.now();
  // Reuse the sync encoders: they project the document to GFM for the body
  // and stamp created/modified as whole-second UTC, like the Android writer.
  const byNote: Record<string, Attachment[]> = {};
  for (const a of input.attachments ?? []) {
    if (!a.meta.noteId) continue;
    (byNote[a.meta.noteId] ??= []).push(a.meta);
  }
  const snap = JSON.parse(
    encodeSnapshot({
      updated: now,
      notes: input.notes,
      deleted: {},
      attachments: byNote,
    }),
  ) as { notes: EncodedNoteJson[] };
  const archive: ZipArchiveJson = {
    app: "Noty",
    exported: isoStamp(now),
    version: 1,
    notes: snap.notes.map((n) => {
      const zn: ZipNoteJson = {
        archived: n.archived ?? false,
        attachments: (n.attachments ?? []).map((a) => ({ ...a })),
        body: n.body ?? "",
        color: n.color ?? 0,
        colorName: NOTE_COLOR_NAMES[n.color ?? 0] ?? "",
        created: n.created,
        id: n.id,
        modified: n.modified,
        order: n.order ?? 0,
        title: n.title ?? "",
      };
      if (n.document) zn.document = n.document;
      return zn;
    }),
  };

  const files: Zippable = {
    [NOTES_ENTRY]: strToU8(JSON.stringify(archive, null, 2)),
  };
  // Payloads travel decrypted; unavailable payloads only skip the binary
  // entry — the metadata stays in notes.json (the importer reports it).
  for (const a of input.attachments ?? []) {
    if (a.bytes) files[attachmentEntryName(a.meta)] = a.bytes;
  }
  // Only the three known extras are written; anything else is ignored so a
  // caller cannot smuggle arbitrary paths into the zip.
  if (input.settings !== undefined) {
    files[SETTINGS_ENTRY] = strToU8(JSON.stringify(input.settings, null, 2));
  }
  if (input.pages !== undefined || input.state !== undefined) {
    files[WIKI_ENTRY] = strToU8(
      JSON.stringify(
        {
          version: 1,
          pages: input.pages ?? [],
          state: input.state ?? emptyWikiState(),
        },
        null,
        2,
      ),
    );
  }
  if (input.chat !== undefined) {
    files[CHAT_ENTRY] = strToU8(
      JSON.stringify({ version: 1, sessions: input.chat }, null, 2),
    );
  }
  return zipSync(files);
}

export function parseBackupZip(bytes: Uint8Array): ParsedBackup {
  if (!looksLikeZip(bytes)) return parseLegacyBackup(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`unreadable backup zip: ${errText(e)}`);
  }

  const notesRaw = entries[NOTES_ENTRY];
  if (!notesRaw || notesRaw.length === 0) {
    throw new Error(`not a NoneNote backup: ${NOTES_ENTRY} missing`);
  }
  const archive = JSON.parse(strFromU8(notesRaw)) as Partial<ZipArchiveJson>;
  if (
    !archive ||
    typeof archive.exported !== "string" ||
    !Array.isArray(archive.notes)
  ) {
    throw new Error("not a NoneNote backup: unrecognized notes.json");
  }
  // The stickies shape shares every field with the sync note schema except
  // `exported` (instead of `updated`); route it through the sync decoder so
  // ISO parsing, document handling and attachment defaults stay in one place.
  const snap = decodeSnapshot(
    JSON.stringify({
      app: archive.app,
      version: archive.version,
      updated: archive.exported,
      notes: archive.notes,
      deleted: [],
    }),
  );
  const notes = snap.notes.map((n) => ({
    ...n,
    title: n.title || derivedTitle(n.body),
  }));

  // Payload entries keyed by attachment id: "attachments/<id>_<fileName>".
  const payloads: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith(ATTACHMENTS_DIR) && !name.endsWith("/")) {
      payloads[name.slice(ATTACHMENTS_DIR.length).split("_", 1)[0]] = data;
    }
  }
  const attachments: { meta: Attachment; bytes: Uint8Array | null }[] = [];
  const failures: BackupImportFailure[] = [];
  for (const items of Object.values(snap.attachments)) {
    for (const meta of items) {
      const data = payloads[meta.id];
      if (!data) {
        failures.push({ name: meta.fileName, reason: "payload file missing in zip" });
        attachments.push({ meta, bytes: null });
        continue;
      }
      if (data.length > MAX_ATTACHMENT_BYTES) {
        failures.push({ name: meta.fileName, reason: "attachment exceeds 50 MB" });
        attachments.push({ meta, bytes: null });
        continue;
      }
      if (sha256Hex(data) !== meta.sha256 || data.length !== meta.size) {
        failures.push({ name: meta.fileName, reason: "sha256 mismatch (corrupt payload)" });
        attachments.push({ meta, bytes: null });
        continue;
      }
      attachments.push({ meta, bytes: data });
    }
  }

  let settings: BackupPrefEntry[] = [];
  let wiki: ParsedBackup["wiki"] = null;
  let chat: ChatSession[] | null = null;
  try {
    const raw = readExtra(entries, SETTINGS_ENTRY);
    if (raw) settings = parseSettingsJson(JSON.parse(strFromU8(raw)));
  } catch (e) {
    failures.push({ name: SETTINGS_ENTRY, reason: errText(e) });
  }
  try {
    const raw = readExtra(entries, WIKI_ENTRY);
    if (raw) wiki = parseWikiJson(JSON.parse(strFromU8(raw)));
  } catch (e) {
    failures.push({ name: WIKI_ENTRY, reason: errText(e) });
  }
  try {
    const raw = readExtra(entries, CHAT_ENTRY);
    if (raw) chat = parseChatJson(JSON.parse(strFromU8(raw)));
  } catch (e) {
    failures.push({ name: CHAT_ENTRY, reason: errText(e) });
  }

  return {
    format: "zip",
    notes,
    attachments,
    failures,
    settings,
    legacySettings: null,
    wiki,
    chat,
  };
}

/** The old single-JSON Windows backup (backup.ts) stays importable. */
function parseLegacyBackup(bytes: Uint8Array): ParsedBackup {
  const legacy = parseBackup(strFromU8(bytes));
  return {
    format: "legacy-json",
    notes: legacy.notes,
    attachments: legacy.attachments.map((a) => ({
      meta: a.meta,
      bytes: decodeAttachmentPayload(a),
    })),
    failures: [],
    settings: [],
    legacySettings: legacy.settings,
    wiki: { pages: legacy.pages, state: legacy.state },
    chat: legacy.chat,
  };
}

function readExtra(entries: Record<string, Uint8Array>, name: string): Uint8Array | null {
  const data = entries[name];
  if (!data || data.length === 0) return null;
  if (data.length > MAX_EXTRA_ENTRY_BYTES) {
    throw new Error(`${name} exceeds 32 MB`);
  }
  return data;
}

/**
 * Android's settings.json is a bare `[{key,type,value}]` array; macOS instead
 * writes `{version, prefs, secrets}`. Accept both on import (Android is the
 * wire-format truth on export), keeping only well-formed entries.
 */
function parseSettingsJson(raw: unknown): BackupPrefEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { prefs?: unknown }).prefs)
      ? (raw as { prefs: unknown[] }).prefs
      : null;
  if (!list) throw new Error("settings.json is not a preference list");
  const out: BackupPrefEntry[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const { key, type, value } = e as Record<string, unknown>;
    if (typeof key !== "string" || typeof value !== "string") continue;
    out.push({ key, type: typeof type === "string" ? type : "string", value });
  }
  return out;
}

function parseWikiJson(raw: unknown): { pages: WikiPage[]; state: WikiState } {
  if (!raw || typeof raw !== "object") {
    throw new Error("wiki.json is not a backup document");
  }
  const doc = raw as { pages?: unknown; state?: unknown };
  const pages: WikiPage[] = Array.isArray(doc.pages)
    ? doc.pages.map(toWikiPage).filter((p): p is WikiPage => p !== null)
    : [];
  const state =
    doc.state && typeof doc.state === "object"
      ? { ...emptyWikiState(), ...(doc.state as WikiState) }
      : emptyWikiState();
  return { pages, state };
}

function toWikiPage(v: unknown): WikiPage | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") return null;
  return {
    name: p.name,
    title: typeof p.title === "string" ? p.title : "",
    kind: typeof p.kind === "string" ? p.kind : "",
    body: typeof p.body === "string" ? p.body : "",
    sourceNoteIds: Array.isArray(p.sourceNoteIds)
      ? p.sourceNoteIds.filter((s): s is string => typeof s === "string")
      : [],
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
  };
}

function parseChatJson(raw: unknown): ChatSession[] {
  const sessions =
    raw && typeof raw === "object" ? (raw as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(sessions)) throw new Error("chat.json is not a backup document");
  return sessions.filter(isChatSession);
}

/** Same shape check as ChatSessionStore's session filter. */
function isChatSession(v: unknown): v is ChatSession {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string" && Array.isArray(s.messages);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pure sync SHA-256 (lowercase hex) for payload verification. crypto.subtle
 * is async and secure-context-gated in the webview and node:crypto does not
 * exist there; this mirrors wiki/text.ts's string variant for bytes.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(bytes: Uint8Array): string {
  const bitLen = bytes.length * 8;
  const paddedLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000));
  view.setUint32(paddedLen - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
  return out;
}
