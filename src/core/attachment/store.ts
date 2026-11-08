import type { Attachment } from "../types.ts";
import { MIME_EXCALIDRAW, PARSE_PENDING } from "../types.ts";
import type { BlobStore } from "../../platform/blobStore.ts";
import type { StorageAdapter } from "../../platform/storage.ts";
import { uuid } from "../text.ts";

const KEY = "attachments";

/** Wire metadata plus a local "the ciphertext/plaintext payload exists" flag. */
export interface LocalAttachment extends Attachment {
  hasPayload: boolean;
}

/** Local attachment library: metadata in one JSON file, bytes in the blob store. */
export class AttachmentStore {
  private readonly storage: StorageAdapter;
  private readonly blobs: BlobStore;
  private cache: LocalAttachment[] | null = null;
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter, blobs: BlobStore) {
    this.storage = storage;
    this.blobs = blobs;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private async ensure(): Promise<LocalAttachment[]> {
    if (this.cache) return this.cache;
    const loaded = await this.storage.load<LocalAttachment[]>(KEY);
    this.cache = (Array.isArray(loaded) ? loaded : [])
      .filter((a) => a && typeof a.id === "string" && typeof a.noteId === "string")
      .map((a) => ({ ...a, hasPayload: a.hasPayload === true }));
    return this.cache;
  }

  async loadAll(): Promise<LocalAttachment[]> {
    return [...(await this.ensure())];
  }

  async byNote(noteId: string): Promise<LocalAttachment[]> {
    return (await this.ensure())
      .filter((a) => a.noteId === noteId)
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  async get(id: string): Promise<LocalAttachment | undefined> {
    return (await this.ensure()).find((a) => a.id === id);
  }

  async upsert(meta: Attachment, hasPayload?: boolean): Promise<LocalAttachment> {
    const list = await this.ensure();
    const existing = list.find((a) => a.id === meta.id);
    const next: LocalAttachment = {
      ...meta,
      hasPayload: hasPayload ?? existing?.hasPayload ?? false,
    };
    this.cache = existing
      ? list.map((a) => (a.id === meta.id ? next : a))
      : [...list, next];
    this.emit();
    await this.persist();
    return next;
  }

  async savePayload(meta: Attachment, bytes: Uint8Array): Promise<void> {
    await this.blobs.write(blobKey(meta.id), bytes);
    await this.upsert(meta, true);
  }

  async payload(id: string): Promise<Uint8Array | null> {
    return this.blobs.read(blobKey(id));
  }

  async remove(id: string): Promise<void> {
    const list = await this.ensure();
    if (!list.some((a) => a.id === id)) return;
    this.cache = list.filter((a) => a.id !== id);
    this.emit();
    await this.blobs.remove(blobKey(id));
    await this.persist();
  }

  // ---- AnalyzerStore seam (used by core/attachment/analyzer.ts) ------------

  private async mutate(id: string, f: (a: LocalAttachment) => LocalAttachment): Promise<void> {
    const list = await this.ensure();
    if (!list.some((a) => a.id === id)) return;
    this.cache = list.map((a) => (a.id === id ? f(a) : a));
    this.emit();
    await this.persist();
  }

  async setExtractedText(id: string, text: string): Promise<void> {
    await this.mutate(id, (a) => ({ ...a, extractedText: text }));
  }

  async setParseStatus(id: string, status: string): Promise<void> {
    await this.mutate(id, (a) => ({ ...a, parseStatus: status }));
  }

  async setAiSummary(id: string, summary: string): Promise<void> {
    await this.mutate(id, (a) => ({ ...a, aiSummary: summary }));
  }

  /**
   * Rows the AI pass should sweep: missing a summary with something to work
   * on — an extracted text layer, or an image/scanned PDF for vision. Mirrors
   * the Android DAO query, extended with hasPayload rows so lazily-extracted
   * documents are covered (Windows extracts lazily, Android at ingest).
   */
  async pendingSummary(): Promise<LocalAttachment[]> {
    return (await this.ensure()).filter(
      (a) =>
        a.aiSummary.trim().length === 0 &&
        a.hasPayload &&
        (a.extractedText.trim().length > 0 || a.kind === "image" || a.mime === "application/pdf"),
    );
  }

  /**
   * Mirrors the merged sync metadata: upserts every remote row (keeping the
   * local payload flag) and drops rows no longer present anywhere.
   */
  async replaceMetadata(byNote: Record<string, Attachment[]>): Promise<void> {
    const list = await this.ensure();
    const existing = new Map(list.map((a) => [a.id, a]));
    const next: LocalAttachment[] = [];
    for (const [noteId, items] of Object.entries(byNote)) {
      for (const a of items) {
        next.push({
          ...a,
          noteId,
          hasPayload: existing.get(a.id)?.hasPayload ?? false,
        });
      }
    }
    const keep = new Set(next.map((a) => a.id));
    const removed = list.filter((a) => !keep.has(a.id));
    this.cache = next;
    this.emit();
    for (const a of removed) await this.blobs.remove(blobKey(a.id));
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = [...(this.cache ?? [])];
    const next = this.chain.then(() => this.storage.save(KEY, snapshot));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function attachmentKind(mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime === MIME_EXCALIDRAW || mime.endsWith("excalidraw+json")) return "diagram";
  return "document";
}

export function newAttachment(
  noteId: string,
  fileName: string,
  mime: string,
  size: number,
  sha256: string,
): Attachment {
  return {
    id: uuid(),
    noteId,
    kind: attachmentKind(mime),
    mime,
    fileName,
    size,
    sha256,
    extractedText: "",
    aiSummary: "",
    parseStatus: mime.startsWith("image/") || mime === MIME_EXCALIDRAW ? "ok" : PARSE_PENDING,
  };
}

/** Web-link attachment row (Android link kind); text lands in extractedText. */
export function newLinkAttachment(noteId: string, fileName: string): Attachment {
  return {
    id: uuid(),
    noteId,
    kind: "link",
    mime: "text/html",
    fileName,
    size: 0,
    sha256: "",
    extractedText: "",
    aiSummary: "",
    parseStatus: PARSE_PENDING,
  };
}

/** Excalidraw diagram row; payload is the .excalidraw JSON document. */
export function newDiagramAttachment(
  noteId: string,
  fileName: string,
  size: number,
  sha256: string,
): Attachment {
  return {
    id: uuid(),
    noteId,
    kind: "diagram",
    mime: MIME_EXCALIDRAW,
    fileName,
    size,
    sha256,
    extractedText: "",
    aiSummary: "",
    parseStatus: "ok",
  };
}

function blobKey(id: string): string {
  return `att-${id}`;
}
