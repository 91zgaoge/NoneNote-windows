import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AttachmentAnalyzer,
  SUMMARY_INPUT_CHARS,
  SUMMARY_SYSTEM,
  VISION_PROMPT,
  capInput,
} from "./analyzer.ts";
import type { AnalyzerStore, ImageData } from "./analyzer.ts";
import type { LlmClient, LlmUsage } from "../ai/client.ts";
import type { Attachment } from "../types.ts";
import type { LocalAttachment } from "./store.ts";

const enc = new TextEncoder();

// ---- fakes -------------------------------------------------------------------

type Row = LocalAttachment;

class FakeStore implements AnalyzerStore {
  rows = new Map<string, Row>();
  statusCalls: string[] = [];
  textCalls: [string, string][] = [];
  summaryCalls: [string, string][] = [];

  async get(id: string): Promise<Row | undefined> {
    return this.rows.get(id);
  }

  async setExtractedText(id: string, text: string): Promise<void> {
    this.touch(id, (r) => ({ ...r, extractedText: text }));
    this.textCalls.push([id, text]);
  }

  async setParseStatus(id: string, status: string): Promise<void> {
    this.touch(id, (r) => ({ ...r, parseStatus: status }));
    this.statusCalls.push(status);
  }

  async setAiSummary(id: string, summary: string): Promise<void> {
    this.touch(id, (r) => ({ ...r, aiSummary: summary }));
    this.summaryCalls.push([id, summary]);
  }

  /** Android DAO query, extended with hasPayload for lazy extraction. */
  async pendingSummary(): Promise<Row[]> {
    return [...this.rows.values()].filter(
      (r) =>
        r.aiSummary === "" &&
        (r.extractedText !== "" || r.kind === "image" || r.mime === "application/pdf" || r.hasPayload),
    );
  }

  private touch(id: string, f: (r: Row) => Row): void {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, f(r));
  }
}

class FakeLlm implements LlmClient {
  chatResponse = "Summary here.\n- point one";
  describeResponse = "A photo of a whiteboard.";
  fail = false;
  chatCalls: [string, string][] = [];
  describeCalls: [string, { mime: string; dataUrl: string }][] = [];

  async chat(system: string, user: string): Promise<string> {
    if (this.fail) throw new Error("boom");
    this.chatCalls.push([system, user]);
    return this.chatResponse;
  }

  async chatWithUsage(system: string, user: string): Promise<[string, LlmUsage]> {
    return [await this.chat(system, user), { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 }];
  }

  async describeImage(prompt: string, image: { mime: string; dataUrl: string }): Promise<string> {
    if (this.fail) throw new Error("boom");
    this.describeCalls.push([prompt, image]);
    return this.describeResponse;
  }
}

function put(store: FakeStore, overrides: Partial<Attachment> & { id: string }): Attachment {
  const a: Attachment = {
    noteId: "n1",
    kind: "document",
    mime: "text/plain",
    fileName: "f.bin",
    size: 1,
    sha256: "ab",
    extractedText: "",
    aiSummary: "",
    parseStatus: "pending",
    ...overrides,
  };
  store.rows.set(a.id, { ...a, hasPayload: false });
  return a;
}

interface Harness {
  store: FakeStore;
  llm: FakeLlm;
  analyzer: AttachmentAnalyzer;
  payloads: Map<string, Uint8Array>;
  visionPrepCalls: number;
  setVisionPrep(prep: ((a: Attachment, bytes: Uint8Array) => Promise<ImageData | null>) | undefined): void;
  setVisionEnabled(on: boolean): void;
  setConfigured(on: boolean): void;
}

function newHarness(): Harness {
  const store = new FakeStore();
  const llm = new FakeLlm();
  const payloads = new Map<string, Uint8Array>();
  const state = {
    visionEnabled: false,
    configured: true,
    visionPrep: undefined as ((a: Attachment, bytes: Uint8Array) => Promise<ImageData | null>) | undefined,
    visionPrepCalls: 0,
  };
  const analyzer = new AttachmentAnalyzer({
    attachments: store,
    loadPayload: async (id) => payloads.get(id) ?? null,
    llm: () => (state.configured ? llm : null),
    visionEnabled: () => state.visionEnabled,
    visionPrep: async (a, bytes) => {
      if (!state.visionPrep) return null;
      state.visionPrepCalls++;
      return state.visionPrep(a, bytes);
    },
    now: () => 0,
  });
  return {
    store,
    llm,
    analyzer,
    payloads,
    get visionPrepCalls() {
      return state.visionPrepCalls;
    },
    setVisionPrep(prep) {
      state.visionPrep = prep;
    },
    setVisionEnabled(on) {
      state.visionEnabled = on;
    },
    setConfigured(on) {
      state.configured = on;
    },
  };
}

// ---- text summarization --------------------------------------------------------

test("document with extracted text gets summary written back", async () => {
  const h = newHarness();
  const a = put(h.store, {
    id: "a1",
    mime: "text/markdown",
    extractedText: "# Report\nSales grew.",
  });

  assert.ok(await h.analyzer.analyze(a.id));

  assert.equal(h.llm.chatCalls.length, 1);
  assert.equal(h.llm.chatCalls[0][0], SUMMARY_SYSTEM);
  assert.ok(h.llm.chatCalls[0][1].includes("# Report"));
  assert.ok(h.llm.chatCalls[0][1].startsWith("FILE f.bin (text/markdown)\n---\n"));
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "Summary here.\n- point one");
  assert.equal(h.store.statusCalls.length, 0); // already-extracted rows untouched
});

test("huge extraction stays within the fixed input budget even with max_tokens at 1M", async () => {
  const h = newHarness();
  // Regression: the input budget used to be keyed to max_tokens, so a
  // 1,048,576 profile delivered whole PDF extractions (~1M tokens per
  // request, retried on every launch by analyzePending).
  const long = "字".repeat(300_000); // 300k CJK chars ≈ 300k tokens if sent whole
  const a = put(h.store, { id: "a2", extractedText: long, mime: "text/plain" });

  assert.ok(await h.analyzer.analyze(a.id));

  assert.equal(h.llm.chatCalls.length, 1);
  const prompt = h.llm.chatCalls[0][1];
  assert.ok(
    prompt.length <= SUMMARY_INPUT_CHARS + 100,
    `prompt should stay within the fixed budget, was ${prompt.length}`,
  );
  assert.ok(prompt.includes("…"));
});

test("capInput caps at the fixed budget and marks the cut", () => {
  assert.equal(capInput("short"), "short"); // untouched within budget
  const latin = capInput("a".repeat(9_000));
  assert.equal(latin.length, SUMMARY_INPUT_CHARS + 1); // chars + ellipsis
  assert.ok(latin.endsWith("…"));
  const cjk = capInput("汉".repeat(9_000));
  assert.equal(cjk.length, SUMMARY_INPUT_CHARS + 1);
});

test("empty extractedText is pulled from the payload, then summarized", async () => {
  const h = newHarness();
  const a = put(h.store, { id: "a3", fileName: "note.txt", mime: "text/plain" });
  h.payloads.set(a.id, enc.encode("From the payload"));

  assert.ok(await h.analyzer.analyze(a.id));

  assert.deepEqual(h.store.textCalls, [[a.id, "From the payload\n"]]);
  assert.deepEqual(h.store.statusCalls, ["ok"]);
  assert.ok(h.llm.chatCalls[0][1].includes("From the payload"));
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "Summary here.\n- point one");
});

test("failed extraction marks parseStatus failed and stays silent", async () => {
  const h = newHarness();
  const a = put(h.store, { id: "a4", fileName: "broken.docx", mime: "" });
  h.payloads.set(a.id, enc.encode("hello there, not a zip"));

  assert.ok(!(await h.analyzer.analyze(a.id)));

  assert.deepEqual(h.store.statusCalls, ["failed"]);
  assert.equal(h.llm.chatCalls.length, 0);
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");
});

test("failed web link is not summarized", async () => {
  const h = newHarness();
  const a = put(h.store, {
    id: "a5",
    kind: "link" as Attachment["kind"],
    mime: "text/html",
    extractedText: "Fetch failed: HTTP 404 (https://x.test)",
  });

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.llm.chatCalls.length, 0);
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");
});

// ---- vision switch ---------------------------------------------------------------

test("image attachment is skipped while vision is off", async () => {
  const h = newHarness();
  h.setVisionPrep(async () => ({ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }));
  const a = put(h.store, { id: "a6", kind: "image", mime: "image/png" });

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.llm.chatCalls.length, 0);
  assert.equal(h.llm.describeCalls.length, 0);
  assert.equal(h.visionPrepCalls, 0);
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");
});

test("image attachment is described when vision is on", async () => {
  const h = newHarness();
  h.setVisionEnabled(true);
  h.setVisionPrep(async () => ({ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }));
  const a = put(h.store, { id: "a7", kind: "image", mime: "image/png" });
  h.payloads.set(a.id, enc.encode("fake png bytes"));

  assert.ok(await h.analyzer.analyze(a.id));

  assert.equal(h.llm.describeCalls.length, 1);
  assert.equal(h.llm.describeCalls[0][0], VISION_PROMPT);
  assert.equal(h.llm.describeCalls[0][1].dataUrl, "data:image/jpeg;base64,QUJD");
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "A photo of a whiteboard.");
});

test("scanned pdf goes through vision when enabled", async () => {
  const h = newHarness();
  h.setVisionEnabled(true);
  h.setVisionPrep(async () => ({ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,UERG" }));
  const a = put(h.store, { id: "a8", mime: "application/pdf", fileName: "scan.pdf" });
  // Not a parseable PDF: no text layer, ingest/analyzer marks it failed, then
  // the mime-based vision path applies (Android maps NeedsOcr → failed too).
  h.payloads.set(a.id, enc.encode("%PDF-1.4 garbage"));

  assert.ok(await h.analyzer.analyze(a.id));

  assert.deepEqual(h.store.statusCalls, ["failed"]);
  assert.equal(h.llm.describeCalls.length, 1);
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "A photo of a whiteboard.");
});

test("scanned pdf without an image prep is skipped silently", async () => {
  const h = newHarness();
  h.setVisionEnabled(true); // visionPrep stays unset → null source
  const a = put(h.store, { id: "a9", mime: "application/pdf" });

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.llm.describeCalls.length, 0);
});

test("text-only client without describeImage skips vision silently", async () => {
  const h = newHarness();
  h.setVisionEnabled(true);
  h.setVisionPrep(async () => ({ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }));
  // Simulate a client whose type lacks the optional method entirely.
  (h.llm as { describeImage?: unknown }).describeImage = undefined;
  const a = put(h.store, { id: "a10", kind: "image", mime: "image/png" });
  h.payloads.set(a.id, enc.encode("fake png bytes"));

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");
  delete (h.llm as { describeImage?: unknown }).describeImage;
});

// ---- degradation & retry -----------------------------------------------------------

test("unconfigured AI leaves the attachment alone and does not call the LLM", async () => {
  const h = newHarness();
  h.setConfigured(false);
  const a = put(h.store, { id: "a11", extractedText: "hello" });

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.llm.chatCalls.length, 0);
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");
});

test("LLM failure keeps the row unsummarized and a later retry succeeds", async () => {
  const h = newHarness();
  const a = put(h.store, { id: "a12", extractedText: "hello" });

  h.llm.fail = true;
  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "");

  h.llm.fail = false;
  assert.ok(await h.analyzer.analyze(a.id));
  assert.equal(h.store.rows.get(a.id)?.aiSummary, "Summary here.\n- point one");
});

test("already summarized attachment is not re-analyzed", async () => {
  const h = newHarness();
  const a = put(h.store, { id: "a13", extractedText: "hello", aiSummary: "old summary" });

  assert.ok(!(await h.analyzer.analyze(a.id)));
  assert.equal(h.llm.chatCalls.length, 0);
});

test("unknown id answers false", async () => {
  const h = newHarness();
  assert.ok(!(await h.analyzer.analyze("missing")));
});

test("analyzePending sweeps only the analyzable backlog", async () => {
  const h = newHarness();
  const doc = put(h.store, { id: "d1", extractedText: "hello" });
  put(h.store, { id: "d2", extractedText: "hi", aiSummary: "done" });
  // Empty payload, no text, not an image/pdf: nothing to analyze.
  put(h.store, { id: "d3", mime: "application/octet-stream" });
  const img = put(h.store, { id: "d4", kind: "image", mime: "image/png" });
  h.payloads.set(img.id, enc.encode("fake png bytes"));
  h.setVisionEnabled(true);
  h.setVisionPrep(async () => ({ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }));

  await h.analyzer.analyzePending();

  assert.equal(h.llm.chatCalls.length, 1);
  assert.equal(h.llm.describeCalls.length, 1);
  assert.ok((h.store.rows.get(doc.id)?.aiSummary ?? "").length > 0);
  assert.equal(h.store.rows.get("d2")?.aiSummary, "done");
  assert.equal(h.store.rows.get("d3")?.aiSummary, "");
  assert.ok((h.store.rows.get(img.id)?.aiSummary ?? "").length > 0);
});
