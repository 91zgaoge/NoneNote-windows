import { basicAuth, statusError } from "../http.ts";
import { base64ToBytes, bytesToBase64 } from "../base64.ts";
import type { HttpTransport } from "../http.ts";

/** The two operations the sync engine needs; seam for fakes in tests. */
export interface SyncTransport {
  /** Returns sync.json content, or null when it does not exist yet. */
  pull(): Promise<string | null>;
  push(json: string): Promise<void>;
}

/**
 * Minimal WebDAV client for the NoneNote sync protocol: the snapshot lives at
 * `{baseUrl}/NoneNote/sync.json`. Basic auth on every request; HTTP goes
 * through the host transport so the Tauri webview has no CORS problem.
 */
export class WebDavClient implements SyncTransport {
  private readonly root: string;
  private readonly dirUrl: string;
  private readonly fileUrl: string;
  private readonly attachmentsUrl: string;
  private readonly auth: string;

  private readonly http: HttpTransport;

  constructor(
    baseUrl: string,
    user: string,
    pass: string,
    http: HttpTransport,
  ) {
    this.http = http;
    this.root = baseUrl.replace(/\/+$/, "");
    this.dirUrl = `${this.root}/NoneNote`;
    this.fileUrl = `${this.dirUrl}/sync.json`;
    this.attachmentsUrl = `${this.dirUrl}/attachments`;
    this.auth = basicAuth(user, pass);
  }

  async pull(): Promise<string | null> {
    const resp = await this.http.request({
      method: "GET",
      url: this.fileUrl,
      headers: { Authorization: this.auth },
    });
    if (resp.status >= 200 && resp.status < 300) return resp.body;
    if (resp.status === 404) {
      await this.ensureCollection();
      return null;
    }
    throw statusError("GET sync.json", resp.status, resp.body);
  }

  async push(json: string): Promise<void> {
    await this.ensureCollection();
    const resp = await this.http.request({
      method: "PUT",
      url: this.fileUrl,
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/json",
      },
      body: json,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("PUT sync.json", resp.status, resp.body);
    }
  }

  /** PROPFIND Depth:0 on the server root; true when the server answers 2xx. */
  async reachable(): Promise<boolean> {
    try {
      const resp = await this.http.request({
        method: "PROPFIND",
        url: `${this.root}/`,
        headers: { Authorization: this.auth, Depth: "0" },
      });
      return resp.status >= 200 && resp.status < 300;
    } catch {
      return false;
    }
  }

  // ---- attachment payloads: NoneNote/attachments/<id> (ciphertext) ----

  async headAttachment(id: string): Promise<number | null> {
    const resp = await this.http.request({
      method: "HEAD",
      url: `${this.attachmentsUrl}/${id}`,
      headers: { Authorization: this.auth },
    });
    if (resp.status === 404) return null;
    if (resp.status >= 200 && resp.status < 300) {
      const length = resp.headers["content-length"];
      return length === undefined ? -1 : Number(length);
    }
    throw statusError("HEAD attachments/" + id, resp.status, resp.body);
  }

  async putAttachment(id: string, bytes: Uint8Array): Promise<void> {
    await this.ensureAttachmentsCollection();
    const resp = await this.http.request({
      method: "PUT",
      url: `${this.attachmentsUrl}/${id}`,
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/octet-stream",
      },
      bodyBase64: bytesToBase64(bytes),
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("PUT attachments/" + id, resp.status, resp.body);
    }
  }

  async getAttachment(id: string): Promise<Uint8Array | null> {
    const resp = await this.http.request({
      method: "GET",
      url: `${this.attachmentsUrl}/${id}`,
      headers: { Authorization: this.auth },
    });
    if (resp.status === 404) return null;
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("GET attachments/" + id, resp.status, resp.body);
    }
    if (!resp.bodyBase64) throw new Error("GET attachments/" + id + ": empty body");
    return base64ToBytes(resp.bodyBase64);
  }

  /** MKCOL the attachments collection (parent is ensured first). */
  private async ensureAttachmentsCollection(): Promise<void> {
    await this.ensureCollection();
    const resp = await this.http.request({
      method: "MKCOL",
      url: this.attachmentsUrl,
      headers: { Authorization: this.auth },
    });
    if (
      (resp.status >= 200 && resp.status < 300) ||
      resp.status === 405 ||
      resp.status === 409
    ) {
      return;
    }
    throw statusError("MKCOL NoneNote/attachments", resp.status, resp.body);
  }

  /** MKCOL the NoneNote collection; an existing collection is fine. */
  private async ensureCollection(): Promise<void> {
    const resp = await this.http.request({
      method: "MKCOL",
      url: this.dirUrl,
      headers: { Authorization: this.auth },
    });
    if (
      (resp.status >= 200 && resp.status < 300) ||
      resp.status === 405 ||
      resp.status === 409
    ) {
      return;
    }
    throw statusError("MKCOL NoneNote", resp.status, resp.body);
  }
}
