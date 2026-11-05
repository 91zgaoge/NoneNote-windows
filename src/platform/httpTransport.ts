import type { HttpRequest, HttpResponse, HttpTransport } from "../core/http.ts";
import { base64ToBytes, bytesToBase64 } from "../core/base64.ts";
import { hasTauri, tauriInvoke } from "./tauri.ts";

class TauriTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    return tauriInvoke<HttpResponse>("http_request", {
      req: {
        method: req.method,
        url: req.url,
        headers: req.headers ?? {},
        body: req.body ?? null,
        bodyBase64: req.bodyBase64 ?? null,
        timeoutMs: req.timeoutMs ?? null,
      },
    });
  }
}

class BrowserTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = req.timeoutMs
      ? setTimeout(() => controller.abort(), req.timeoutMs)
      : null;
    try {
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.bodyBase64
          ? (base64ToBytes(req.bodyBase64) as unknown as BodyInit)
          : req.body,
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const body = new TextDecoder().decode(bytes);
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: resp.status, headers, body, bodyBase64: bytesToBase64(bytes) };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const httpTransport: HttpTransport = hasTauri()
  ? new TauriTransport()
  : new BrowserTransport();
