/**
 * Pure planning for a web note — port of Android's web/WebNote.kt text
 * conventions. The link attachment's extractedText doubles as the link-card
 * payload and follows a machine-readable convention the viewer parses back:
 *   success: "Source: <finalUrl>\n\n<markdown>"
 *   failure: "Fetch failed: <reason> (<url>)"
 *
 * Windows-port deviation from Android: a 200 whose HTML yields no readable
 * content is a failure ("no readable content") instead of degrading to the
 * bare URL as the note body — the parent wiring asked for the failing shape.
 */

import type { FetchError, FetchOutcome } from "./linkFetcher.ts";
import { htmlToReadableGfm } from "./readability.ts";

export const SOURCE_PREFIX = "Source: ";
export const FAILURE_PREFIX = "Fetch failed: ";

export interface WebNoteText {
  ok: boolean;
  text: string;
}

/** Android WebNote.describe — user-facing reason phrasing for a FetchError. */
export function describeFetchError(error: FetchError): string {
  switch (error.kind) {
    case "unsupported":
      return "unsupported scheme";
    case "http":
      return `HTTP ${error.status}`;
    case "not_html":
      return `not an HTML page (${error.detail ?? "unknown content-type"})`;
    case "too_large":
      return "page exceeds 5 MB";
    case "network":
      return error.detail ?? "network error";
  }
}

export function webNoteText(url: string, outcome: FetchOutcome): WebNoteText {
  if (outcome.ok) {
    const readable = htmlToReadableGfm(outcome.body);
    if (readable === null) {
      return { ok: false, text: `${FAILURE_PREFIX}no readable content (${url})` };
    }
    return { ok: true, text: `${SOURCE_PREFIX}${outcome.finalUrl}\n\n${readable}` };
  }
  return { ok: false, text: `${FAILURE_PREFIX}${describeFetchError(outcome.error)} (${url})` };
}
