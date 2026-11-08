import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHtml } from "./html.ts";
import { renderGfm } from "./gfm.ts";
import { extractText } from "./textExtractor.ts";

const enc = new TextEncoder();

test("html: headings, lists, links, styles render through the GFM funnel", () => {
  const html =
    "<html><head><title>chrome</title><style>body{}</style></head><body>" +
    "<h1>Top</h1>" +
    "<p>plain <b>bold</b> <i>it</i> <code>co</code> <a href='https://x.test/a'>a link</a></p>" +
    "<ul><li>one</li><li>two<p>inner</p></li></ul>" +
    "<ol><li>first</li><li>second</li></ol>" +
    "<div><h3>Nested</h3></div>" +
    "</body></html>";
  // Whitespace-only text runs between styled elements are dropped (jsoup
  // TextNode semantics), and element boundaries add no spaces of their own,
  // so "two<p>inner</p>" concatenates — same as Android.
  assert.equal(
    renderGfm(extractHtml(enc.encode(html))),
    "# Top\n\n" +
      "plain **bold***it*`co`[a link](https://x.test/a)\n\n" +
      "- one\n- twoinner\n\n" +
      "1. first\n2. second\n\n" +
      "### Nested\n",
  );
});

test("html: script, style, noscript, template and head chrome are skipped", () => {
  const html =
    "<html><head><title>t</title><meta charset='utf-8'></head><body>" +
    "<script>var x = '<p>not a para</p>';</script>" +
    "<style>.a { color: red; }</style>" +
    "<noscript>no js</noscript><template><p>tpl</p></template>" +
    "<p>real</p></body></html>";
  const md = renderGfm(extractHtml(enc.encode(html)));
  assert.equal(md, "real\n");
});

test("html: entities decode in text and attributes", () => {
  const html =
    "<body><h1>A &amp; B &lt;tag&gt; &#65;&#x42;</h1>" +
    "<p><a href='/?a=1&amp;b=2'>&quot;q&quot;</a></p>" +
    "<p>caf&eacute;&nbsp;wide</p></body>";
  assert.equal(
    renderGfm(extractHtml(enc.encode(html))),
    "# A & B <tag> AB\n\n" +
      '["q"](/?a=1&b=2)\n\n' +
      "café\u00a0wide\n",
  );
});

test("html: tables pick up th/td cells through thead/tbody", async () => {
  const html =
    "<body><table>" +
    "<thead><tr><th>H|1</th><th>H2</th></tr></thead>" +
    "<tbody><tr><td>a</td><td><b>x</b>y</td></tr></tbody>" +
    "</table></body>";
  const r = await extractText("t.html", "text/html", enc.encode(html));
  assert.deepEqual(r, {
    ok: true,
    markdown: "| H\\|1 | H2 |\n| --- | --- |\n| a | **x**y |\n",
    format: "html",
  });
});

test("html: ragged rows pad to the widest row", async () => {
  const r = await extractText(
    "t.html",
    "text/html",
    enc.encode("<body><table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table></body>"),
  );
  assert.deepEqual(r, {
    ok: true,
    markdown: "| a | b |\n| --- | --- |\n| 1 |  |\n",
    format: "html",
  });
});

test("html: img alt becomes an image block, empty html is malformed", async () => {
  const blocks = extractHtml(enc.encode("<body><img src='x.png' alt=' a pic '></body>")).blocks;
  assert.deepEqual(blocks, [{ kind: "image", alt: "a pic" }]);
  const r = await extractText(
    "blank.html",
    "text/html",
    enc.encode("<html><head></head><body></body></html>"),
  );
  assert.deepEqual(r, { ok: false, error: { kind: "malformed", detail: "no content extracted" } });
});
