import type { AppSettings, Note, WikiPage, WikiState } from "../core/types.ts";
import { emptyWikiState } from "../core/types.ts";
import { decodeSnapshot, encodeSnapshot } from "../core/sync/codec.ts";

/**
 * Full backup (settings, notes, wiki) in one JSON file. Mirrors the Android
 * 1.11.2 extras: notes.json + settings.json + wiki.json in a single archive
 * payload. The file is plain text and contains credentials — the UI warns
 * before export.
 */
export interface BackupFile {
  app: "NoneNote";
  format: "windows-backup";
  version: 1;
  exportedAt: string;
  notes: unknown[];
  settings: AppSettings;
  wiki: { pages: WikiPage[]; state: WikiState };
}

export function makeBackup(
  notes: Note[],
  settings: AppSettings,
  pages: WikiPage[],
  state: WikiState,
): BackupFile {
  return {
    app: "NoneNote",
    format: "windows-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: JSON.parse(encodeSnapshot({
      updated: Date.now(),
      notes,
      deleted: {},
      attachments: {},
    })).notes,
    settings,
    wiki: { pages, state },
  };
}

export function parseBackup(text: string): {
  notes: Note[];
  settings: Partial<AppSettings>;
  pages: WikiPage[];
  state: WikiState;
} {
  const parsed = JSON.parse(text) as Partial<BackupFile>;
  if (parsed.app !== "NoneNote" || parsed.format !== "windows-backup") {
    throw new Error("not a NoneNote Windows backup");
  }
  const notes = parsed.notes
    ? decodeSnapshot(JSON.stringify({ updated: new Date().toISOString(), notes: parsed.notes, deleted: [] })).notes
    : [];
  return {
    notes,
    settings: parsed.settings ?? {},
    pages: parsed.wiki?.pages ?? [],
    state: parsed.wiki?.state ?? emptyWikiState(),
  };
}
