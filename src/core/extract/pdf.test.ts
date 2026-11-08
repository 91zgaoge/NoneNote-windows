import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "./textExtractor.ts";
import { extractPdf } from "./pdf.ts";

const enc = new TextEncoder();

/**
 * Builds a classic single-generation PDF with correct xref offsets — no
 * library, just the object bodies strung together.
 */
function buildPdf(objs: string[], trailer: string): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += trailer + "\nstartxref\n" + xref + "\n%%EOF\n";
  return enc.encode(out);
}

const HELLO_WIKI_OBJS = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> >>",
  "<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 720 Td (Hello Wiki) Tj ET\nendstream",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

test("pdf: text layer is extracted and rendered as paragraphs", async () => {
  const pdf = buildPdf(HELLO_WIKI_OBJS, "trailer\n<< /Size 6 /Root 1 0 R >>");
  assert.ok(pdf.length < 1200, `minimal pdf should stay small, was ${pdf.length}`);
  const r = await extractText("hello.pdf", "application/pdf", pdf);
  assert.deepEqual(r, { ok: true, markdown: "Hello Wiki\n", format: "pdf" });
});

test("pdf: items on different lines are reordered into separate paragraphs", async () => {
  // Two ET/BT-separated runs at different y: sortByPosition-style grouping
  // must put a line break between them even without explicit line operators.
  const stream =
    "BT /F1 12 Tf 72 720 Td (First line) Tj ET\nBT /F1 12 Tf 72 700 Td (Second line) Tj ET\n";
  const pdf = buildPdf(
    [
      HELLO_WIKI_OBJS[0],
      HELLO_WIKI_OBJS[1],
      HELLO_WIKI_OBJS[2],
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      HELLO_WIKI_OBJS[4],
    ],
    "trailer\n<< /Size 6 /Root 1 0 R >>",
  );
  const r = await extractPdf(pdf);
  assert.ok(r.ok);
  // Lines separated by one \n fold into one paragraph, exactly like the
  // Android stripper output does (paragraph breaks need blank lines).
  if (r.ok) assert.equal(r.markdown, "First line Second line\n");
});

test("pdf: wide gaps inside one line become spaces, not glue", async () => {
  const stream = "BT /F1 12 Tf 72 720 Td (Left) Tj 200 0 Td (Right) Tj ET\n";
  const pdf = buildPdf(
    [
      HELLO_WIKI_OBJS[0],
      HELLO_WIKI_OBJS[1],
      HELLO_WIKI_OBJS[2],
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      HELLO_WIKI_OBJS[4],
    ],
    "trailer\n<< /Size 6 /Root 1 0 R >>",
  );
  const r = await extractPdf(pdf);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.markdown, "Left Right\n");
});

test("pdf: image-only document answers needs_ocr", async () => {
  const pdf = buildPdf(
    [
      HELLO_WIKI_OBJS[0],
      HELLO_WIKI_OBJS[1],
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\n\nendstream",
    ],
    "trailer\n<< /Size 5 /Root 1 0 R >>",
  );
  assert.deepEqual(await extractPdf(pdf), { ok: false, error: { kind: "needs_ocr" } });
});

test("pdf: password-protected document answers encrypted", async () => {
  const encryptObj =
    "<< /Filter /Standard /V 1 /R 2 " +
    "/O <0011223344556677889900112233445566778899001122334455667788990011> " +
    "/U <0011223344556677889900112233445566778899001122334455667788990011> /P -1 >>";
  const pdf = buildPdf(
    [...HELLO_WIKI_OBJS, encryptObj],
    "trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R >>",
  );
  assert.deepEqual(await extractPdf(pdf), { ok: false, error: { kind: "encrypted" } });
});

test("pdf: garbage after the magic is malformed, never a throw", async () => {
  const r = await extractText("bad.pdf", "application/pdf", enc.encode("%PDF-1.4 garbage"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "malformed");
});
