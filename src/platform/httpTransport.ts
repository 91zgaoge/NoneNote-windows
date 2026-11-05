import type { HttpRequest, HttpResponse, HttpTransport } from "../core/http.ts";
import { hasTauri, tauriInvoke } from "./tauri.ts";

class TauriTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    return tauriInvoke<HttpResponse>("http_request", {
      req: {
        method: req.method,
        url: req.url,
        headers: req.headers ?? {},
        body: req.body ?? null,
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
        body: req.body,
        signal: controller.signal,
      });
      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: resp.status, headers, body };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const httpTransport: HttpTransport = hasTauri()
  ? new TauriTransport()
  : new BrowserTransport();
