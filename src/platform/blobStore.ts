import { base64ToBytes, bytesToBase64 } from "../core/base64.ts";
import { hasTauri, tauriInvoke } from "./tauri.ts";

/** Binary payload storage under the app-data directory. */
export interface BlobStore {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

class TauriBlobStore implements BlobStore {
  async write(key: string, bytes: Uint8Array): Promise<void> {
    await tauriInvoke("blob_write", { key, base64: bytesToBase64(bytes) });
  }
  async read(key: string): Promise<Uint8Array | null> {
    const raw = await tauriInvoke<string | null>("blob_read", { key });
    return raw === null ? null : base64ToBytes(raw);
  }
  async remove(key: string): Promise<void> {
    await tauriInvoke("blob_delete", { key });
  }
}

class WebBlobStore implements BlobStore {
  async write(key: string, bytes: Uint8Array): Promise<void> {
    localStorage.setItem(`nonenote.blob.${key}`, bytesToBase64(bytes));
  }
  async read(key: string): Promise<Uint8Array | null> {
    const raw = localStorage.getItem(`nonenote.blob.${key}`);
    return raw === null ? null : base64ToBytes(raw);
  }
  async remove(key: string): Promise<void> {
    localStorage.removeItem(`nonenote.blob.${key}`);
  }
}

export const blobs: BlobStore = hasTauri() ? new TauriBlobStore() : new WebBlobStore();
