/** Shared domain types. Wire-format compatible with the Android/macOS clients. */

export type BlockType =
  | "paragraph"
  | "heading"
  | "task"
  | "bullet"
  | "quote"
  | "code"
  | "image"
  | "canvas"
  | "unknown";

export interface NoteBlock {
  type: BlockType;
  id?: string;
  text?: string;
  level?: number;
  checked?: boolean;
  language?: string;
  attachmentId?: string;
  alt?: string;
  title?: string;
  rawType?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export interface NoteDocument {
  schemaVersion: number;
  blocks: NoteBlock[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  color: number;
  created: number;
  modified: number;
  archived: boolean;
  pinned: boolean;
  order: number;
  /** Android 1.11 block document. Preserved verbatim across sync. */
  document?: NoteDocument | null;
}

export type AttachmentKind = "document" | "image" | "audio" | "video" | "canvas";

export interface Attachment {
  id: string;
  noteId: string;
  kind: AttachmentKind;
  mime: string;
  fileName: string;
  size: number;
  sha256: string;
  extractedText: string;
  aiSummary: string;
  parseStatus: string;
}

export const PARSE_PENDING = "pending";
export const PARSE_FAILED = "failed";
export const PARSE_EMPTY = "empty";

export interface SyncSnapshot {
  updated: number;
  notes: Note[];
  deleted: Record<string, number>;
  attachments: Record<string, Attachment[]>;
}

export interface ConceptState {
  name: string;
  kind: string;
  summary: string;
  sourceNoteIds: string[];
}

export interface WikiState {
  noteHashes: Record<string, string>;
  concepts: Record<string, ConceptState>;
  failedPages: string[];
  pendingPages: string[];
}

export interface WikiPage {
  name: string;
  title: string;
  kind: string;
  body: string;
  sourceNoteIds: string[];
  updatedAt: number;
}

export interface AiProfile {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export const SYNC_MODE_BOTH = "both";
export const SYNC_MODE_UPLOAD = "upload";
export const SYNC_MODE_DOWNLOAD = "download";
export const SYNC_DELETION_BOTH = "both";
export const SYNC_DELETION_LOCAL_OFF = "local_off";
export const SYNC_DELETION_REMOTE_OFF = "remote_off";

export interface AppSettings {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  syncMode: string;
  syncDeletion: string;
  syncDeletedJson: string;
  syncKnownIdsJson: string;
  profiles: AiProfile[];
  activeProfileId: string;
  wikiExtractProfileId: string;
  wikiMaxPagesPerRun: number;
  language: "en" | "zh";
}

export function emptyWikiState(): WikiState {
  return { noteHashes: {}, concepts: {}, failedPages: [], pendingPages: [] };
}

export function emptySettings(): AppSettings {
  const profile: AiProfile = {
    id: "default",
    label: "Default",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.7,
    maxTokens: 2048,
  };
  return {
    webdavUrl: "",
    webdavUser: "",
    webdavPass: "",
    syncMode: SYNC_MODE_BOTH,
    syncDeletion: SYNC_DELETION_BOTH,
    syncDeletedJson: "",
    syncKnownIdsJson: "",
    profiles: [profile],
    activeProfileId: profile.id,
    wikiExtractProfileId: "",
    wikiMaxPagesPerRun: 0,
    language: "en",
  };
}

export function activeProfile(s: AppSettings): AiProfile {
  return s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0];
}

export function extractProfile(s: AppSettings): AiProfile {
  return (
    s.profiles.find((p) => p.id === s.wikiExtractProfileId) ??
    activeProfile(s)
  );
}

export function noteDisplayTitle(n: Note): string {
  return n.title || "New note";
}
