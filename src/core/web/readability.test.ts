import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToReadableGfm, readabilityExtract } from "./readability.ts";

const PAGE = `<html><head><title>Test Page</title></head><body>
<nav><a href="/a">NavLinkA</a><a href="/b">NavLinkB</a></nav>
<article>
<h1>Big Heading</h1>
<p>This is the first substantial paragraph of body text, with a comma and more words to push the length well past eighty characters for the semantic threshold. It mentions *stars* and a <strong>bold bit</strong>.</p>
<p>Second paragraph continues the article with additional sentences so the article element comfortably wins the content root selection, see <a href="https://example.com">Example</a>.</p>
</article>
<footer><p>Footer legal junk</p></footer>
</body></html>`;

test("readability strips nav/footer and keeps the article", () => {
  const md = htmlToReadableGfm(PAGE);
  assert.notEqual(md, null);
  assert.match(md!, /^# Big Heading\n\n/);
  assert.match(md!, /first substantial paragraph/);
  assert.match(md!, /Second paragraph continues/);
  assert.equal(md!.includes("NavLinkA"), false);
  assert.equal(md!.includes("Footer legal junk"), false);
});

test("readability renders DocModel inline conventions", () => {
  const md = htmlToReadableGfm(PAGE)!;
  assert.ok(md.includes("\\*stars\\*"), `escaped stars missing: ${md}`);
  assert.ok(md.includes("**bold bit**"), `bold missing: ${md}`);
  assert.ok(md.includes("[Example](https://example.com)"), `link missing: ${md}`);
});

test("readability renders lists", () => {
  const html = `<body><article><h2>Steps</h2>
<ul><li>First item with plenty of words to help fill the semantic trust threshold quota</li>
<li>Second item with plenty of words to help fill the semantic trust threshold quota</li></ul>
<ol><li>One step described at length so the article text crosses eighty characters</li>
<li>Two steps described at length so the article text crosses eighty characters</li></ol>
</article></body>`;
  const md = htmlToReadableGfm(html)!;
  assert.ok(
    md.includes("- First item with plenty of words to help fill the semantic trust threshold quota\n- Second item with plenty of words to help fill the semantic trust threshold quota"),
    `bullet list missing: ${md}`,
  );
  assert.ok(
    md.includes("1. One step described at length so the article text crosses eighty characters\n2. Two steps described at length so the article text crosses eighty characters"),
    `ordered list missing: ${md}`,
  );
  assert.ok(md.startsWith("## Steps\n\n"));
});

test("readability drops unlikely candidates but keeps positive overrides", () => {
  const html = `<body>
<div class="sidebar promo-widget"><p>Sidebar junk sponsored content</p></div>
<div class="ad-content"><p>Positive override paragraph, with commas, that survives the unlikely ad- prefix because the class contains the keyword content, and it also runs long enough to win the density contest outright here.</p></div>
</body>`;
  const md = htmlToReadableGfm(html);
  assert.notEqual(md, null);
  assert.equal(md!.includes("Sidebar junk"), false);
  assert.match(md!, /Positive override paragraph/);
});

test("readability falls back to density scoring without semantic tags", () => {
  const html = `<body>
<div class="menu"><a href="/1">MenuLink1</a> <a href="/2">MenuLink2</a> <a href="/3">MenuLink3</a></div>
<div id="mainish"><p>Real content paragraph that talks about many things, includes commas, and runs long enough to dominate the density score over everything else present here.</p></div>
</body>`;
  const md = htmlToReadableGfm(html)!;
  assert.match(md, /Real content paragraph/);
  assert.equal(md.includes("MenuLink1"), false);
});

test("readability keeps header/footer inside the article", () => {
  const html = `<body><article>
<header><p>Story header line that adds context to the piece and also helps push the total article text comfortably past the eighty character semantic threshold mark.</p></header>
<p>Main story body paragraph, which is where most of the actual content lives for this particular test fixture.</p>
</article></body>`;
  const md = htmlToReadableGfm(html)!;
  assert.match(md, /Story header line/);
  assert.match(md, /Main story body/);
});

test("readability renders tables through the GFM conventions", () => {
  const html = `<body><article><p>Intro paragraph long enough to clear the eighty character semantic trust threshold for article containers on this page.</p>
<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apples</td><td>3</td></tr></table></article></body>`;
  const md = htmlToReadableGfm(html)!;
  assert.ok(md.includes("| Name | Qty |\n| --- | --- |\n| Apples | 3 |"), `table missing: ${md}`);
});

test("readability returns null when nothing is readable", () => {
  assert.equal(htmlToReadableGfm(""), null);
  assert.equal(htmlToReadableGfm("<html><head></head><body></body></html>"), null);
  assert.equal(
    htmlToReadableGfm("<html><body><script>var x = 1;</script><style>p{}</style></body></html>"),
    null,
  );
});

test("readability decodes entities", () => {
  const html = `<body><article><p>Tom &amp; Jerry said &lt;hi&gt; and continued with a long tail of words so the article text comfortably clears the eighty character semantic threshold mark here.</p></article></body>`;
  const md = htmlToReadableGfm(html)!;
  assert.match(md, /Tom & Jerry said <hi>/);
});

test("readability title: og:title beats title element beats h1", () => {
  assert.equal(
    readabilityExtract('<head><meta property="og:title" content="OG Title"><title>El Title</title></head><body><article><p>Content paragraph long enough to clear the eighty character semantic threshold for this article fixture, with a comma.</p></article></body>')!
      .title,
    "OG Title",
  );
  assert.equal(
    readabilityExtract('<head><title>El Title</title></head><body><article><p>Content paragraph long enough to clear the eighty character semantic threshold for this article fixture, with a comma.</p></article></body>')!
      .title,
    "El Title",
  );
  assert.equal(
    readabilityExtract('<body><article><h1>Fallback H1</h1><p>Content paragraph long enough to clear the eighty character semantic threshold for this article fixture, with a comma.</p></article></body>')!
      .title,
    "Fallback H1",
  );
});

test("aria-hidden and role chrome are stripped", () => {
  const html = `<body><article><p>Main content paragraph long enough to clear the eighty character semantic trust threshold for this readability test fixture on the page.</p></article>
<div role="navigation"><p>RoleNav junk content</p></div><div aria-hidden="true"><p>Hidden junk content</p></div></body>`;
  const md = htmlToReadableGfm(html)!;
  assert.match(md, /Main content paragraph/);
  assert.equal(md.includes("RoleNav junk"), false);
  assert.equal(md.includes("Hidden junk"), false);
});
