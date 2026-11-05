import type {
  Attachment,
  AttachmentKind,
  Note,
  SyncSnapshot,
} from "../types.ts";
import { PARSE_PENDING } from "../types.ts";
import { projectDocument } from "../document.ts";
import { isoStamp, parseIso } from "../text.ts";

interface SyncAttachmentJson {
  id: string;
  kind?: string;
  mime?: string;
  fileName?: string;
  size?: number;
  sha256?: string;
  extractedText?: string;
  aiSummary?: string;
  parseStatus?: string;
}

interface SyncNoteJson {
  id: string;
  title?: string;
  body?: string;
  document?: Note["document"];
  color?: number;
  created: string;
  modified: string;
  archived?: boolean;
  pinned?: boolean;
  order?: number;
  attachments?: SyncAttachmentJson[];
}

interface SyncDeletedJson {
  id: string;
  deletedAt: string;
}

interface SyncFileJson {
  app?: string;
  version?: number;
  updated: string;
  notes?: SyncNoteJson[];
  deleted?: SyncDeletedJson[];
}

const KINDS: AttachmentKind[] = ["document", "image", "audio", "video", "canvas"];

function kindOf(s: string | undefined): AttachmentKind {
  return KINDS.includes(s as AttachmentKind) ? (s as AttachmentKind) : "document";
}

/** Encode a snapshot exactly as the shared sync.json protocol pins it. */
export function encodeSnapshot(snapshot: SyncSnapshot): string {
  const file: SyncFileJson = {
    app: "NoneNote",
    version: 1,
    updated: isoStamp(snapshot.updated),
    notes: snapshot.notes.map((n) => {
      const document = n.document ?? null;
      const body = document ? projectDocument(document) : n.body;
      return {
        id: n.id,
        title: n.title,
        body,
        ...(document ? { document } : {}),
        color: n.color,
        created: isoStamp(n.created),
        modified: isoStamp(n.modified),
        archived: n.archived,
        pinned: n.pinned,
        order: n.order,
        attachments: (snapshot.attachments[n.id] ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          mime: a.mime,
          fileName: a.fileName,
          size: a.size,
          sha256: a.sha256,
          extractedText: a.extractedText,
          aiSummary: a.aiSummary,
          parseStatus: a.parseStatus,
        })),
      };
    }),
    deleted: Object.entries(snapshot.deleted).map(([id, at]) => ({
      id,
      deletedAt: isoStamp(at),
    })),
  };
  return JSON.stringify(file);
}

export function decodeSnapshot(text: string): SyncSnapshot {
  const file = JSON.parse(text) as SyncFileJson;
  if (!file || typeof file.updated !== "string") {
    throw new Error("sync.json: missing updated timestamp");
  }
  const attachments: Record<string, Attachment[]> = {};
  const notes: Note[] = (file.notes ?? []).map((s) => {
    const document = s.document ?? null;
    const body = document ? projectDocument(document) : (s.body ?? "");
    const list: Attachment[] = (s.attachments ?? []).map((a) => ({
      id: a.id,
      noteId: s.id,
      kind: kindOf(a.kind),
      mime: a.mime ?? "",
      fileName: a.fileName ?? "",
      size: a.size ?? 0,
      sha256: a.sha256 ?? "",
      extractedText: a.extractedText ?? "",
      aiSummary: a.aiSummary ?? "",
      parseStatus: a.parseStatus || PARSE_PENDING,
    }));
    if (list.length > 0) attachments[s.id] = list;
    return {
      id: s.id,
      title: s.title ?? "",
      body,
      color: s.color ?? 0,
      created: parseIso(s.created),
      modified: parseIso(s.modified),
      archived: s.archived ?? false,
      pinned: s.pinned ?? false,
      order: s.order ?? 0,
      document,
    };
  });
  const deleted: Record<string, number> = {};
  for (const d of file.deleted ?? []) deleted[d.id] = parseIso(d.deletedAt);
  return {
    updated: parseIso(file.updated),
    notes,
    deleted,
    attachments,
  };
}
