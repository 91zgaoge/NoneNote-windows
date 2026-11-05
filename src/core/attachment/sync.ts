import type { AppSettings, Attachment, SyncSnapshot } from "../types.ts";
import { cipheredSize, sha256HexBytes, SyncCipher } from "./crypto.ts";
import type { AttachmentStore } from "./store.ts";

export interface AttachmentStats {
  uploaded: number;
  downloaded: number;
  failed: number;
  failures: string[];
}

export interface AttachmentTransport {
  headAttachment(id: string): Promise<number | null>;
  putAttachment(id: string, bytes: Uint8Array): Promise<void>;
  getAttachment(id: string): Promise<Uint8Array | null>;
}

/**
 * Uploads local payloads that the server lacks/mismatches and downloads
 * remote payloads this device lacks. Payloads are re-sealed with the
 * WebDAV-password cipher, so the server only ever stores ciphertext.
 */
export class AttachmentSync {
  private readonly store: AttachmentStore;
  private readonly clientFactory: (cfg: AppSettings) => AttachmentTransport;

  constructor(store: AttachmentStore, clientFactory: (cfg: AppSettings) => AttachmentTransport) {
    this.store = store;
    this.clientFactory = clientFactory;
  }

  async sync(merged: SyncSnapshot, cfg: AppSettings): Promise<AttachmentStats> {
    const stats: AttachmentStats = { uploaded: 0, downloaded: 0, failed: 0, failures: [] };
    const all: Attachment[] = Object.values(merged.attachments).flat();
    if (all.length === 0) return stats;
    if (!cfg.webdavPass) {
      return {
        ...stats,
        failed: all.length,
        failures: ["WebDAV password is required to sync attachments"],
      };
    }
    const cipher = await SyncCipher.create(cfg.webdavPass);
    const client = this.clientFactory(cfg);

    for (const meta of all) {
      try {
        const local = await this.store.get(meta.id);
        const hasPayload = local?.hasPayload === true;
        const remoteSize = await client.headAttachment(meta.id);
        if (hasPayload) {
          if (remoteSize === cipheredSize(meta.size)) continue;
          const bytes = await this.store.payload(meta.id);
          if (!bytes) throw new Error("local payload is missing");
          const sealed = await cipher.seal(bytes);
          if (sealed.length !== cipheredSize(meta.size)) {
            throw new Error("local payload size does not match its metadata");
          }
          await client.putAttachment(meta.id, sealed);
          stats.uploaded++;
        } else if (remoteSize !== null) {
          const sealed = await client.getAttachment(meta.id);
          if (!sealed) continue;
          const plain = await cipher.open(sealed);
          if (plain.length !== meta.size) throw new Error("decrypted size mismatch");
          if ((await sha256HexBytes(plain)) !== meta.sha256) {
            throw new Error("decrypted sha256 mismatch");
          }
          await this.store.savePayload(meta, plain);
          stats.downloaded++;
        }
      } catch (e) {
        stats.failed++;
        stats.failures.push(`${meta.fileName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return stats;
  }
}
