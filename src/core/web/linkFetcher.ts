/**
 * Fetches a single web page for the share-with-URL flow — port of Android's
 * web/LinkFetcher.kt over the Windows HttpTransport seam. Guards: http/https
 * only, MAX_PAGE_BYTES response cap (Content-Length pre-check plus accumulated
 * body size, since Content-Length can lie), 30s timeout passthrough, redirects
 * followed manually and capped at MAX_REDIRECTS. Never throws — every failure
 * is a typed FetchError with Android's kinds and phrasing semantics.
 */

import type { HttpTransport, HttpRequest, HttpResponse } from "../http.ts";
import { base64ToBytes } from "../base64.ts";

/** Pages larger than this are refused (design: 5 MB response cap). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Manual redirect cap (Windows port spec: <= 4; Android default is 5). */
export const MAX_REDIRECTS = 4;

export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Browser-ish UA (Windows port spec): many gateways reject non-browser
 * clients; the NoneNote identity is kept as a suffix. Android sends
 * "NoneNote/1.1 (Android; link fetcher)".
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 NoneNote/1.1 (Windows; link fetcher)";

export type FetchErrorKind =
  | "unsupported"
  | "network"
  | "http"
  | "not_html"
  | "too_large";

export interface FetchError {
  kind: FetchErrorKind;
  /** "http" only: the non-2xx response code. */
  status?: number;
  /** Extra context: offending scheme/url, content-type, or network message. */
  detail?: string;
}

export type FetchOutcome =
  | { ok: true; body: string; finalUrl: string }
  | { ok: false; error: FetchError };

function header(resp: HttpResponse, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(resp.headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function err(kind: FetchErrorKind, extra: { status?: number; detail?: string } = {}): FetchOutcome {
  return { ok: false, error: { kind, ...extra } };
}

function base64ByteLength(b64: string): number {
  let padding = 0;
  for (let i = b64.length - 1; i >= 0 && b64[i] === "="; i--) padding++;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Re-decode non-UTF-8 bodies from the raw bytes (the transport decodes UTF-8-lossy). */
function decodeCharset(bytes: Uint8Array, contentType: string | null, utf8Fallback: string): string {
  const match =
    contentType !== null ? /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i.exec(contentType) : null;
  if (match === null) return utf8Fallback;
  const charset = match[1].toLowerCase();
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii" || charset === "ascii") {
    return utf8Fallback;
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return utf8Fallback;
  }
}

export class LinkFetcher {
  private readonly transport: HttpTransport;
  private readonly maxRedirects: number;

  constructor(transport: HttpTransport, maxRedirects: number = MAX_REDIRECTS) {
    this.transport = transport;
    this.maxRedirects = maxRedirects;
  }

  async fetch(url: string): Promise<FetchOutcome> {
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return err("unsupported", { detail: current });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return err("unsupported", { detail: current });
      }
      const request: HttpRequest = {
        method: "GET",
        url: current,
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: FETCH_TIMEOUT_MS,
      };
      let resp: HttpResponse;
      try {
        resp = await this.transport.request(request);
      } catch (e) {
        return err("network", { detail: e instanceof Error ? e.message : String(e) });
      }
      if (resp.status >= 300 && resp.status <= 399) {
        const location = header(resp, "location");
        if (location === null) return err("http", { status: resp.status });
        let next: URL;
        try {
          next = new URL(location, parsed);
        } catch {
          return err("network", { detail: `bad redirect: ${location}` });
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return err("unsupported", { detail: location });
        }
        current = next.toString();
        continue;
      }
      if (resp.status < 200 || resp.status > 299) return err("http", { status: resp.status });
      const contentType = header(resp, "content-type");
      const mime =
        contentType !== null ? contentType.split(";")[0].trim().toLowerCase() : "";
      if (mime !== "text/html" && mime !== "application/xhtml+xml") {
        return err("not_html", { detail: contentType ?? undefined });
      }
      // Size cap: Content-Length when present, accumulated bytes always.
      const contentLength = header(resp, "content-length");
      if (contentLength !== null) {
        const len = Number.parseInt(contentLength, 10);
        if (Number.isFinite(len) && len > MAX_PAGE_BYTES) return err("too_large");
      }
      const byteLength =
        resp.bodyBase64 !== undefined
          ? base64ByteLength(resp.bodyBase64)
          : new TextEncoder().encode(resp.body).length;
      if (byteLength > MAX_PAGE_BYTES) return err("too_large");
      const body =
        resp.bodyBase64 !== undefined
          ? decodeCharset(base64ToBytes(resp.bodyBase64), contentType, resp.body)
          : resp.body;
      return { ok: true, body, finalUrl: current };
    }
    return err("network", { detail: `too many redirects (> ${this.maxRedirects})` });
  }
}
