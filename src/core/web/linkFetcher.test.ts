import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse, HttpTransport } from "../http.ts";
import { bytesToBase64 } from "../base64.ts";
import { FETCH_TIMEOUT_MS, LinkFetcher, MAX_PAGE_BYTES } from "./linkFetcher.ts";

function resp(
  status: number,
  headers: Record<string, string> = {},
  body = "",
  bodyBase64?: string,
): HttpResponse {
  return { status, headers, body, bodyBase64 };
}

class FakeTransport implements HttpTransport {
  calls: HttpRequest[] = [];
  private responder: (req: HttpRequest) => HttpResponse;

  constructor(responder: (req: HttpRequest) => HttpResponse) {
    this.responder = responder;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return this.responder(req);
  }
}

function routeTransport(routes: Map<string, HttpResponse>): FakeTransport {
  return new FakeTransport((req) => {
    const hit = routes.get(req.url);
    if (hit === undefined) throw new Error(`no route for ${req.url}`);
    return hit;
  });
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

test("linkFetcher GETs with browser-ish UA and 30s timeout", async () => {
  const transport = routeTransport(new Map([["https://a.test/", resp(200, HTML_HEADERS, "<p>hi</p>")]]));
  const outcome = await new LinkFetcher(transport).fetch("https://a.test/");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].method, "GET");
  assert.match(transport.calls[0].headers?.["User-Agent"] ?? "", /NoneNote/);
  assert.match(transport.calls[0].headers?.["User-Agent"] ?? "", /Mozilla\/5\.0/);
  assert.equal(transport.calls[0].timeoutMs, FETCH_TIMEOUT_MS);
  assert.deepEqual(outcome, { ok: true, body: "<p>hi</p>", finalUrl: "https://a.test/" });
});

test("linkFetcher follows a redirect chain and reports the final URL", async () => {
  const transport = routeTransport(
    new Map([
      ["http://a.test/start", resp(301, { location: "http://b.test/mid" })],
      ["http://b.test/mid", resp(301, { location: "/final" })],
      ["http://b.test/final", resp(200, HTML_HEADERS, "<p>landed</p>")],
    ]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/start");
  assert.ok(outcome.ok);
  assert.equal(outcome.finalUrl, "http://b.test/final");
  assert.equal(outcome.body, "<p>landed</p>");
  assert.equal(transport.calls.length, 3);
});

test("linkFetcher caps redirects at 4 with a network error", async () => {
  const routes = new Map<string, HttpResponse>();
  for (let i = 0; i <= 5; i++) {
    routes.set(`http://a.test/${i}`, resp(301, { location: `http://a.test/${i + 1}` }));
  }
  const transport = routeTransport(routes);
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/0");
  assert.deepEqual(outcome, {
    ok: false,
    error: { kind: "network", detail: "too many redirects (> 4)" },
  });
  assert.equal(transport.calls.length, 5);
});

test("linkFetcher rejects redirects to non-http schemes", async () => {
  const transport = routeTransport(
    new Map([["http://a.test/", resp(302, { location: "ftp://b.test/file" })]]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.deepEqual(outcome, {
    ok: false,
    error: { kind: "unsupported", detail: "ftp://b.test/file" },
  });
});

test("linkFetcher reports http error when a 3xx has no Location", async () => {
  const transport = routeTransport(new Map([["http://a.test/", resp(302, {})]]));
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.deepEqual(outcome, { ok: false, error: { kind: "http", status: 302 } });
});

test("linkFetcher maps non-2xx to the http kind", async () => {
  for (const status of [404, 500, 403]) {
    const transport = routeTransport(
      new Map([["http://a.test/", resp(status, HTML_HEADERS, "nope")]]),
    );
    const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
    assert.deepEqual(outcome, { ok: false, error: { kind: "http", status } });
  }
});

test("linkFetcher refuses non-html content types", async () => {
  const transport = routeTransport(
    new Map([["http://a.test/", resp(200, { "content-type": "application/json" }, "{}")]]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.deepEqual(outcome, {
    ok: false,
    error: { kind: "not_html", detail: "application/json" },
  });
});

test("linkFetcher accepts xhtml", async () => {
  const transport = routeTransport(
    new Map([["http://a.test/", resp(200, { "content-type": "application/xhtml+xml" }, "<p>x</p>")]]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.ok(outcome.ok);
});

test("linkFetcher enforces the 5 MB cap via Content-Length", async () => {
  const transport = routeTransport(
    new Map([
      ["http://a.test/", resp(200, { ...HTML_HEADERS, "content-length": String(MAX_PAGE_BYTES + 1) }, "tiny")],
    ]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.deepEqual(outcome, { ok: false, error: { kind: "too_large" } });
});

test("linkFetcher enforces the 5 MB cap on the accumulated body", async () => {
  const bytes = new Uint8Array(MAX_PAGE_BYTES + 1);
  const transport = routeTransport(
    new Map([["http://a.test/", resp(200, HTML_HEADERS, "", bytesToBase64(bytes))]]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.deepEqual(outcome, { ok: false, error: { kind: "too_large" } });
});

test("linkFetcher allows a body right at the cap", async () => {
  const bytes = new Uint8Array(MAX_PAGE_BYTES);
  const transport = routeTransport(
    new Map([["http://a.test/", resp(200, HTML_HEADERS, "", bytesToBase64(bytes))]]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.ok(outcome.ok);
});

test("linkFetcher refuses non-http and unparseable schemes", async () => {
  const transport = routeTransport(new Map());
  for (const url of ["ftp://example.com/x", "file:///tmp/a.html", "javascript:alert(1)", "bogus"]) {
    const outcome = await new LinkFetcher(transport).fetch(url);
    assert.deepEqual(outcome, { ok: false, error: { kind: "unsupported", detail: url } });
  }
  assert.equal(transport.calls.length, 0);
});

test("linkFetcher maps transport failures to the network kind", async () => {
  const transport = new FakeTransport(() => {
    throw new Error("request: connection refused");
  });
  const outcome = await new LinkFetcher(transport).fetch("https://a.test/");
  assert.deepEqual(outcome, {
    ok: false,
    error: { kind: "network", detail: "request: connection refused" },
  });
});

test("linkFetcher decodes non-UTF-8 charsets from the raw bytes", async () => {
  // "你好" in GBK (你 = C4E3, 好 = BAC3).
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
  const transport = routeTransport(
    new Map([
      [
        "http://a.test/",
        resp(200, { "content-type": "text/html; charset=GBK" }, "\uFFFD\uFFFD\uFFFD\uFFFD", bytesToBase64(gbk)),
      ],
    ]),
  );
  const outcome = await new LinkFetcher(transport).fetch("http://a.test/");
  assert.ok(outcome.ok);
  assert.equal(outcome.body, "你好");
});
