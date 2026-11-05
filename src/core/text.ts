import type { Note } from "./types.ts";

const HEADING_RE = /^#{1,6}\s*/;
const IMAGE_LINE_RE = /^!\[.*?]\(.*?\)\s*$/;
const TASK_RE = /^\s*[-*]\s*\[[ xX]]\s*/;

/** First non-blank, non-image line, heading/task markers stripped, ≤60 chars. */
export function derivedTitle(body: string): string {
  const line = body
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0 && !IMAGE_LINE_RE.test(l.trim()));
  if (line === undefined) return "";
  let clean = line.trim().replace(HEADING_RE, "");
  clean = clean.replace(TASK_RE, "");
  if (clean.startsWith("☐") || clean.startsWith("☑")) clean = clean.slice(1).trim();
  if (clean.length === 0) return "";
  return clean.length > 60 ? clean.slice(0, 60) + "…" : clean;
}

export function notePreview(n: Note): string {
  const lines = n.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !IMAGE_LINE_RE.test(l));
  const rest = lines.slice(1).join(" ").trim();
  return rest.length > 120 ? rest.slice(0, 120) + "…" : rest;
}

export function taskProgress(n: Note): [number, number] | null {
  let done = 0;
  let total = 0;
  for (const line of n.body.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])]\s*(.*)$/);
    if (m) {
      total++;
      if (m[1].toLowerCase() === "x") done++;
    }
  }
  return total > 0 ? [done, total] : null;
}

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Whole-second ISO8601 UTC, matching Android's sync.json writer. */
export function isoStamp(epochMs: number): string {
  const d = new Date(Math.floor(epochMs / 1000) * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Accepts `...ssZ`, fractional seconds, and numeric offsets. Throws on junk. */
export function parseIso(s: string): number {
  const t = s.trim();
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`Unparseable ISO timestamp: ${s}`);
  return ms;
}
