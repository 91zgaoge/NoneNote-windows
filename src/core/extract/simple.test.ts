import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCsv, extractPlainText, parseCsv } from "./simple.ts";
import { renderGfm } from "./gfm.ts";

const enc = new TextEncoder();

test("plain text: blank-line chunks become paragraphs, inner newlines fold to spaces", () => {
  const md = renderGfm(
    extractPlainText(enc.encode("First para\nstill first\r\n\r\nSecond\rpara\n\n\n")),
  );
  assert.equal(md, "First para still first\n\nSecond para\n");
});

test("csv: quoted fields, escaped quotes, CRLF, trailing blank rows dropped", () => {
  // A lone `"` opens a quoted field that swallows the rest; the resulting
  // all-blank trailing row is dropped like Android's dropLastWhile.
  assert.deepEqual(parseCsv('a,b\n1,"x""y"\r\n"\n\n '), [
    ["a", "b"],
    ["1", 'x"y'],
  ]);
  // Quoted field containing commas and newlines stays one field.
  assert.deepEqual(parseCsv('a,"b,c\nd",e'), [["a", "b,c\nd", "e"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("csv: extraction renders the first row as the GFM header", () => {
  const md = renderGfm(extractCsv(enc.encode("Name,Score\nAda,100\nBob,|87|")));
  assert.equal(md, "| Name | Score |\n| --- | --- |\n| Ada | 100 |\n| Bob | \\|87\\| |\n");
});
