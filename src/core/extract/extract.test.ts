import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGfm, escapeText } from "./gfm.ts";
import { sniff, sniffZip, zipEntryNames } from "./sniff.ts";
import { extractText } from "./textExtractor.ts";
import { Limits } from "./types.ts";
import type { Block, DocModel } from "./types.ts";
import { zipSync, strToU8 } from "fflate";

const enc = new TextEncoder();

// ---- GFM serializer golden cases ---------------------------------------------

test("gfm renders headings, lists and images with one blank line between blocks", () => {
  const doc: DocModel = {
    blocks: [
      { kind: "heading", level: 2, inlines: [{ kind: "text", text: "Title", bold: false, italic: false, code: false }] },
      { kind: "paragraph", inlines: [{ kind: "text", text: "Body", bold: false, italic: false, code: false }] },
      {
        kind: "bulletList",
        items: [
          [{ kind: "text", text: "one", bold: false, italic: false, code: false }],
          [{ kind: "text", text: "two", bold: false, italic: false, code: false }],
        ],
      },
      {
        kind: "orderedList",
        items: [
          [{ kind: "text", text: "first", bold: false, italic: false, code: false }],
          [{ kind: "text", text: "second", bold: false, italic: false, code: false }],
        ],
      },
      { kind: "image", alt: "pic [x]" },
      { kind: "code", language: "ts", text: "let a = 1;" },
    ],
  };
  assert.equal(
    renderGfm(doc),
    [
      "## Title",
      "Body",
      "- one\n- two",
      "1. first\n2. second",
      "![pic \\[x\\]]()",
      "```ts\nlet a = 1;\n```",
    ].join("\n\n") + "\n",
  );
});

test("gfm tables escape pipes and break inner newlines", () => {
  const t = (s: string): Block => ({
    kind: "table",
    rows: [
      [
        [{ kind: "text", text: s, bold: false, italic: false, code: false }],
        [{ kind: "text", text: "b", bold: false, italic: false, code: false }],
      ],
    ],
  });
  assert.equal(renderGfm({ blocks: [t("a|b")] }), "| a\\|b | b |\n| --- | --- |\n");
  assert.equal(renderGfm({ blocks: [t("a\nb")] }), "| a<br>b | b |\n| --- | --- |\n");
});

test("gfm styles nest code inside bold inside italic like Android", () => {
  const doc: DocModel = {
    blocks: [
      {
        kind: "paragraph",
        inlines: [{ kind: "text", text: "x*y", bold: true, italic: true, code: true }],
      },
    ],
  };
  // escape → `x\*y` → **`x\*y`** → ***`x\*y`***
  assert.equal(renderGfm(doc), "***`x\\*y`***\n");
});

test("escapeText escapes the characters that would flip GFM meaning", () => {
  assert.equal(escapeText("a*b_c[d]e`f\\g"), "a\\*b\\_c\\[d\\]e\\`f\\\\g");
  assert.equal(escapeText("plain"), "plain");
});

test("gfm trims trailing whitespace and ends with one newline", () => {
  assert.equal(renderGfm({ blocks: [] }), "\n");
});

// ---- sniff -------------------------------------------------------------------

test("sniff detects PDF, OLE and HTML magic before extensions", () => {
  assert.equal(sniff(enc.encode("%PDF-1.7"), "x.bin"), "pdf");
  assert.equal(
    sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "x.bin"),
    "ole",
  );
  assert.equal(sniff(enc.encode("<html><body>hi"), "x.txt"), "html");
  assert.equal(sniff(enc.encode("  <!DOCTYPE html><html>"), "x.txt"), "html");
});

test("sniff distinguishes OOXML containers and ODF by member names", () => {
  const asZip = (names: string[]): Uint8Array => {
    const files: Record<string, Uint8Array> = {};
    for (const n of names) files[n] = strToU8("");
    return zipSync(files);
  };
  assert.equal(sniff(asZip(["word/document.xml"]).slice(0, 8192), "", () =>
    zipEntryNames(asZip(["word/document.xml"])), ), "docx");
  const xlsxZip = asZip(["xl/workbook.xml", "xl/_rels/x.rels"]);
  assert.equal(sniff(xlsxZip.subarray(0, 4), "a", () => zipEntryNames(xlsxZip)), "xlsx");
  const pptxZip = asZip(["ppt/presentation.xml"]);
  assert.equal(sniff(pptxZip.subarray(0, 4), "a", () => zipEntryNames(pptxZip)), "pptx");
  const odfZip = asZip(["mimetype", "content.xml"]);
  assert.equal(sniff(odfZip.subarray(0, 4), "a", () => zipEntryNames(odfZip)), "odf");
  const plainZip = asZip(["readme.txt"]);
  assert.equal(sniff(plainZip.subarray(0, 4), "a", () => zipEntryNames(plainZip)), "unknown");
});

test("sniff falls back to the extension", () => {
  for (const [ext, want] of [
    ["csv", "csv"],
    ["txt", "txt"],
    ["md", "md"],
    ["markdown", "md"],
    ["html", "html"],
    ["htm", "html"],
    ["docx", "docx"],
    ["xlsx", "xlsx"],
    ["pptx", "pptx"],
    ["pdf", "pdf"],
    ["xyz", "unknown"],
  ] as const) {
    assert.equal(sniff(enc.encode("nothing special"), `file.${ext}`), want, ext);
  }
  assert.equal(sniff(enc.encode("nothing special"), "no-extension"), "unknown");
});

test("zipEntryNames lists central-directory names without decompressing", () => {
  const zip = zipSync({
    "word/document.xml": strToU8("<doc/>"),
    "word/_rels/x": strToU8("y"),
  });
  assert.deepEqual(zipEntryNames(zip), ["word/document.xml", "word/_rels/x"]);
  assert.deepEqual(zipEntryNames(enc.encode("not a zip")), []);
});

// ---- facade ------------------------------------------------------------------

test("facade routes txt, md and csv by content or extension", async () => {
  const txt = await extractText("a.txt", "text/plain", enc.encode("First para\nstill first\n\nSecond"));
  assert.deepEqual(txt, {
    ok: true,
    markdown: "First para still first\n\nSecond\n",
    format: "txt",
  });
  const md = await extractText("a.markdown", "text/markdown", enc.encode("# H\n\ntext"));
  assert.deepEqual(md, { ok: true, markdown: "# H\n\ntext\n", format: "md" });
  const csv = await extractText("a.csv", "text/csv", enc.encode("h1,h2\n1,2"));
  assert.deepEqual(csv, { ok: true, markdown: "| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n", format: "csv" });
});

test("facade classifies failures", async () => {
  assert.deepEqual(await extractText("x.xyz", "application/octet-stream", enc.encode("\u0000\u0001\u0002")), {
    ok: false,
    error: { kind: "unsupported", detail: "unknown" },
  });
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.deepEqual(await extractText("legacy.doc", "application/msword", ole), {
    ok: false,
    error: { kind: "unsupported", detail: "legacy office (ole)" },
  });
  const odf = zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text") });
  assert.deepEqual(await extractText("x.odt", "application/vnd.oasis.opendocument.text", odf), {
    ok: false,
    error: { kind: "unsupported", detail: "odf" },
  });
});

test("facade enforces the attachment size cap", async () => {
  const oversized = new Uint8Array(Limits.MAX_ATTACHMENT_BYTES + 1);
  assert.deepEqual(await extractText("big.txt", "text/plain", oversized), {
    ok: false,
    error: {
      kind: "resource_limit",
      detail: `attachment exceeds ${Limits.MAX_ATTACHMENT_BYTES} bytes`,
    },
  });
});

test("facade caps extracted text at the 1M-character limit", async () => {
  const chunk = "word\n\n".repeat(200_000); // ~1.2 MB
  const r = await extractText("long.txt", "text/plain", enc.encode(chunk));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.markdown.length, Limits.MAX_TEXT_CHARS);
  }
});

test("facade maps an empty extraction to malformed, never throws on garbage", async () => {
  assert.deepEqual(
    await extractText("empty.txt", "text/plain", enc.encode("  \n\n  \n")),
    { ok: false, error: { kind: "malformed", detail: "no content extracted" } },
  );
  // Extension says docx, content is not a zip: classified, not thrown.
  assert.deepEqual(
    await extractText("broken.docx", "", enc.encode("PK\u0003\u0004 not really a zip")),
    { ok: false, error: { kind: "unsupported", detail: "unknown" } },
  );
  const notZip = await extractText("plain-name.docx", "", enc.encode("hello there"));
  assert.deepEqual(notZip, {
    ok: false,
    error: { kind: "malformed", detail: "missing word/document.xml" },
  });
});

test("facade routes a real docx through the ooxml parser", async () => {
  const doc =
    '<?xml version="1.0"?><w:document xmlns:w="u"><w:body>' +
    '<w:p><w:r><w:t>From facade</w:t></w:r></w:p>' +
    "</w:body></w:document>";
  const zip = zipSync({ "word/document.xml": strToU8(doc) });
  assert.deepEqual(await extractText("real.docx", "", zip), {
    ok: true,
    markdown: "From facade\n",
    format: "docx",
  });
});
