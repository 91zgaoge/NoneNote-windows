import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE_PREFIX, SOURCE_PREFIX, describeFetchError, webNoteText } from "./webNote.ts";
import type { FetchError, FetchOutcome } from "./linkFetcher.ts";

const HTML = `<html><body><article><h1>Title</h1><p>Body paragraph long enough to clear the eighty character semantic threshold for the article container on this page.</p></article></body></html>`;

function ok(finalUrl: string, body: string): FetchOutcome {
  return { ok: true, body, finalUrl };
}

function fail(error: FetchError): FetchOutcome {
  return { ok: false, error };
}

test("webNote success embeds Source: <finalUrl> then the readable GFM", () => {
  const note = webNoteText("http://a.test/x", ok("http://b.test/final", HTML));
  assert.equal(note.ok, true);
  assert.equal(
    note.text,
    "Source: http://b.test/final\n\n# Title\n\nBody paragraph long enough to clear the eighty character semantic threshold for the article container on this page.",
  );
  assert.ok(note.text.startsWith(SOURCE_PREFIX));
});

test("webNote renders Android's failure phrasing per error kind", () => {
  const cases: Array<[FetchError, string]> = [
    [{ kind: "unsupported" }, "Fetch failed: unsupported scheme (http://a.test/)"],
    [{ kind: "http", status: 404 }, "Fetch failed: HTTP 404 (http://a.test/)"],
    [
      { kind: "not_html", detail: "application/json" },
      "Fetch failed: not an HTML page (application/json) (http://a.test/)",
    ],
    [
      { kind: "not_html" },
      "Fetch failed: not an HTML page (unknown content-type) (http://a.test/)",
    ],
    [{ kind: "too_large" }, "Fetch failed: page exceeds 5 MB (http://a.test/)"],
    [
      { kind: "network", detail: "connection refused" },
      "Fetch failed: connection refused (http://a.test/)",
    ],
  ];
  for (const [error, expected] of cases) {
    const note = webNoteText("http://a.test/", fail(error));
    assert.equal(note.ok, false);
    assert.equal(note.text, expected);
  }
});

test("webNote treats an unreadable 200 page as a failure with a reason", () => {
  const note = webNoteText("http://a.test/", ok("http://a.test/", "<html><body></body></html>"));
  assert.equal(note.ok, false);
  assert.equal(note.text, "Fetch failed: no readable content (http://a.test/)");
});

test("webNote prefixes match Android's WebNote constants", () => {
  assert.equal(SOURCE_PREFIX, "Source: ");
  assert.equal(FAILURE_PREFIX, "Fetch failed: ");
});

test("describeFetchError mirrors Android's WebNote.describe", () => {
  assert.equal(describeFetchError({ kind: "unsupported" }), "unsupported scheme");
  assert.equal(describeFetchError({ kind: "http", status: 503 }), "HTTP 503");
  assert.equal(describeFetchError({ kind: "too_large" }), "page exceeds 5 MB");
  assert.equal(describeFetchError({ kind: "network", detail: "timeout" }), "timeout");
  assert.equal(
    describeFetchError({ kind: "not_html", detail: "text/plain" }),
    "not an HTML page (text/plain)",
  );
});
