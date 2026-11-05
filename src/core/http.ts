export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Binary body; wins over [body] when present. */
  bodyBase64?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Base64 of the raw response bytes (for attachment downloads). */
  bodyBase64?: string;
}

/** Seam for tests and for the Tauri/browser transport split. */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return "Basic " + btoa(binary);
}

export function statusError(what: string, status: number, body: string): Error {
  const detail = body.length > 300 ? body.slice(0, 300) + "…" : body;
  return new Error(`${what} failed: HTTP ${status}${detail ? ` — ${detail}` : ""}`);
}
