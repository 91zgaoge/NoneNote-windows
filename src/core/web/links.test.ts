import { test } from "node:test";
import assert from "node:assert/strict";
import { findUrls, firstUrl } from "./links.ts";

test("findUrls extracts http/https URLs in order", () => {
  assert.deepEqual(findUrls("see https://a.com/x and http://b.org"), [
    "https://a.com/x",
    "http://b.org",
  ]);
});

test("findUrls trims trailing sentence punctuation", () => {
  assert.deepEqual(findUrls("go to https://a.com."), ["https://a.com"]);
  assert.deepEqual(findUrls("(https://a.com/x), then..."), ["https://a.com/x"]);
  assert.deepEqual(findUrls("done: https://a.com]"), ["https://a.com"]);
});

test("findUrls keeps interior punctuation", () => {
  assert.deepEqual(findUrls("https://a.com/a(b)c?q=1,2"), ["https://a.com/a(b)c?q=1,2"]);
});

test("findUrls dedupes exact repeats preserving first order", () => {
  assert.deepEqual(
    findUrls("https://a.com https://b.com https://a.com"),
    ["https://a.com", "https://b.com"],
  );
});

test("findUrls ignores non-http schemes", () => {
  assert.deepEqual(findUrls("ftp://files.example.com file:///tmp/x javascript:alert(1)"), []);
});

test("findUrls is case-insensitive on the scheme", () => {
  assert.deepEqual(findUrls("HTTPS://A.COM/Path"), ["HTTPS://A.COM/Path"]);
});

test("findUrls returns empty for no URLs", () => {
  assert.deepEqual(findUrls("no links here"), []);
  assert.deepEqual(findUrls(""), []);
});

test("firstUrl returns the first URL or null", () => {
  assert.equal(firstUrl("try https://a.com then http://b.org"), "https://a.com");
  assert.equal(firstUrl("nope."), null);
});
