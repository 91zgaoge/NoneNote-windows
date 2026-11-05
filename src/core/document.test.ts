import { test } from "node:test";
import assert from "node:assert/strict";
import {
  documentProjectionForAi,
  parseMarkdown,
  projectDocument,
  structuralKey,
} from "./document.ts";
import type { Attachment, Note } from "./types.ts";

test("markdown parse/project round-trips supported blocks", () => {
  const md = "# Heading\n\npara\n☐ task\n☑ done\n- bullet\n> quote\n```ts\nlet x = 1\n```\n![alt](attachment:a1)";
  const doc = parseMarkdown(md);
  const out = projectDocument(doc);
  assert.match(out, /# Heading/);
  assert.match(out, /☐ task/);
  assert.match(out, /☑ done/);
  assert.match(out, /- bullet/);
  assert.match(out, /> quote/);
  assert.match(out, /```ts\nlet x = 1\n```/);
  assert.match(out, /!\[alt]\(attachment:a1\)/);
  // Re-parsing the projection keeps the same structure.
  assert.equal(structuralKey(parseMarkdown(out)), structuralKey(doc));
});

test("document projection is reading-order, includes attachment text, and is bounded", () => {
  const a: Attachment = {
    id: "a1",
    noteId: "n1",
    kind: "document",
    mime: "text/plain",
    fileName: "a.txt",
    size: 1,
    sha256: "",
    extractedText: "hello attachment",
    aiSummary: "",
    parseStatus: "ready",
  };
  const n: Note = {
    id: "n1",
    title: "T",
    body: "# Head\npara\n![img](attachment:a1)",
    color: 0,
    created: 0,
    modified: 0,
    archived: false,
    pinned: false,
    order: 0,
    document: parseMarkdown("# Head\npara\n![img](attachment:a1)"),
  };
  const out = documentProjectionForAi(n, [a]);
  assert.match(out, /NOTE id=n1 title=T/);
  assert.match(out, /\[heading1] Head/);
  assert.match(out, /\[image a1] alt=img/);
  assert.match(out, /hello attachment/);
  // Referenced attachments must not be appended twice.
  assert.equal(out.match(/--- attachment:/g), null);

  const bounded = documentProjectionForAi(n, [a], 40);
  assert.match(bounded, /truncated/);
  assert.ok(bounded.length <= 40 + "\n[... truncated: this note alone exceeded the prompt budget ...]".length);
});

test("unreferenced attachments are appended after the document", () => {
  const a: Attachment = {
    id: "a2",
    noteId: "n1",
    kind: "document",
    mime: "text/plain",
    fileName: "extra.txt",
    size: 1,
    sha256: "",
    extractedText: "extra text",
    aiSummary: "",
    parseStatus: "ready",
  };
  const n: Note = {
    id: "n1",
    title: "T",
    body: "para",
    color: 0,
    created: 0,
    modified: 0,
    archived: false,
    pinned: false,
    order: 0,
  };
  const out = documentProjectionForAi(n, [a]);
  assert.match(out, /--- attachment: extra.txt \(document\) ---/);
  assert.match(out, /extra text/);
});
