import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BATCH_NOTES,
  OVERVIEW_PAGE,
  WikiCompiler,
  chunkText,
  type Progress,
  type Summary,
  type WikiStore,
} from "./compiler.ts";
import type { LlmClient, LlmUsage } from "../ai/client.ts";
import type { Note, WikiPage, WikiState } from "../types.ts";
import { emptyWikiState } from "../types.ts";

const USAGE: LlmUsage = { promptTokens: 3, completionTokens: 4, cachedPromptTokens: 5 };

function note(id: string, title: string, body: string, modified = 1000): Note {
  return {
    id,
    title,
    body,
    color: 0,
    created: 1,
    modified,
    archived: false,
    pinned: false,
    order: 0,
  };
}

class TestStore implements WikiStore {
  pages = new Map<string, WikiPage>();
  state: WikiState = emptyWikiState();
  saveConcurrency = 0;
  maxSaveConcurrency = 0;

  async loadPages(): Promise<WikiPage[]> {
    return [...this.pages.values()];
  }
  async savePage(page: WikiPage): Promise<void> {
    this.saveConcurrency++;
    this.maxSaveConcurrency = Math.max(this.maxSaveConcurrency, this.saveConcurrency);
    await new Promise((r) => setTimeout(r, 1));
    this.pages.set(page.name, page);
    this.saveConcurrency--;
  }
  async deletePage(name: string): Promise<void> {
    this.pages.delete(name);
  }
  async loadState(): Promise<WikiState> {
    return structuredClone(this.state);
  }
  async saveState(state: WikiState): Promise<void> {
    this.state = structuredClone(state);
  }
}

interface FakeOptions {
  extract?: (user: string, call: number) => string;
  page?: (name: string, prompt: string, call: number) => string;
  overview?: string;
  delayMs?: number;
  usage?: LlmUsage;
}

class FakeLlm implements LlmClient {
  extractCalls = 0;
  pageCalls: string[] = [];
  pagePrompts: string[] = [];
  extractPrompts: string[] = [];
  overviewCalls = 0;
  pageInFlight = 0;
  maxPageInFlight = 0;
  private readonly opts: FakeOptions;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  async chat(system: string, user: string, max?: number): Promise<string> {
    const [text] = await this.chatWithUsage(system, user, max);
    return text;
  }

  async chatWithUsage(
    system: string,
    user: string,
    _max?: number,
  ): Promise<[string, LlmUsage]> {
    if (system.includes("extract the key concepts")) {
      this.extractCalls++;
      this.extractPrompts.push(user);
      const call = this.extractCalls;
      const text = this.opts.extract
        ? this.opts.extract(user, call)
        : defaultExtract(user);
      return [text, this.opts.usage ?? USAGE];
    }
    if (system.includes("overview index")) {
      this.overviewCalls++;
      return [
        this.opts.overview ??
          JSON.stringify({ title: "Overview", body: "# Overview\nAll pages." }),
        this.opts.usage ?? USAGE,
      ];
    }
    const name = /Name: (.+)/.exec(user)?.[1]?.trim() ?? "Page";
    const call = this.pageCalls.length;
    this.pageCalls.push(name);
    this.pagePrompts.push(user);
    this.pageInFlight++;
    this.maxPageInFlight = Math.max(this.maxPageInFlight, this.pageInFlight);
    try {
      if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
      const text = this.opts.page
        ? this.opts.page(name, user, call)
        : defaultPage(name);
      return [text, this.opts.usage ?? USAGE];
    } finally {
      this.pageInFlight--;
    }
  }
}

function defaultExtract(user: string): string {
  const ids = [...user.matchAll(/NOTE id=(\S+)/g)].map((m) => m[1]);
  const unique = [...new Set(ids)];
  const concepts = unique.map((id) => ({
    name: `Concept ${id}`,
    kind: "concept",
    summary: `Summary of ${id}`,
    sourceNoteIds: [id],
  }));
  return "```json\n" + JSON.stringify(concepts) + "\n```";
}

function defaultPage(name: string): string {
  return JSON.stringify({
    title: `${name} page`,
    body:
      `# ${name}\nA substantial page about ${name} with enough detail to be useful. ` +
      "See also [[overview]].",
  });
}

function makeCompiler(
  notes: () => Note[],
  store: WikiStore,
  llm: LlmClient,
  extra: Partial<ConstructorParameters<typeof WikiCompiler>[0]> = {},
): WikiCompiler {
  return new WikiCompiler({
    notesProvider: notes,
    llm,
    store,
    ...extra,
  });
}

test("messy fenced extraction compiles pages with provenance and state", async () => {
  const n1 = note("n1", "Kotlin coroutines", "Kotlin coroutines body");
  const n2 = note("n2", "Japan trip", "Japan trip body");
  const store = new TestStore();
  const llm = new FakeLlm({
    extract: () =>
      'Here are the concepts:\n```json\n[{"name":"Coroutines","kind":"concept",' +
      '"summary":"Async in Kotlin","sourceNoteIds":["n1"]},' +
      '{"name":"Japan Trip","kind":"entity","summary":"Travel","sourceNoteIds":["n2"]}]\n```\nHope this helps',
  });
  const progress: Progress[] = [];
  const summary = await makeCompiler(() => [n1, n2], store, llm, {
    onProgress: (p) => progress.push(p),
  }).compile();

  assert.deepEqual(new Set(store.pages.keys()), new Set(["Coroutines", "Japan Trip", OVERVIEW_PAGE]));
  assert.equal(summary.generated, 3);
  assert.equal(summary.skippedUnchanged, 0);
  assert.equal(llm.extractCalls, 1);
  assert.equal(llm.overviewCalls, 1);
  const page = store.pages.get("Coroutines")!;
  assert.equal(page.kind, "concept");
  assert.deepEqual(page.sourceNoteIds, ["n1"]);
  assert.match(page.body, /## Sources/);
  assert.match(page.body, /`n1`/);
  assert.deepEqual(Object.keys(store.state.noteHashes).sort(), ["n1", "n2"]);
  assert.deepEqual(store.state.concepts.Coroutines.sourceNoteIds, ["n1"]);
  assert.ok(progress.some((p) => p.phase === "EXTRACT" && p.step === "start"));
  assert.ok(progress.some((p) => p.phase === "PAGES" && p.label === "Coroutines"));
  assert.ok(progress.some((p) => p.step === "prepare"));
  assert.ok(summary.promptTokens > 0 && summary.completionTokens > 0);
});

test("unchanged notes skip the LLM entirely on recompile", async () => {
  const n1 = note("n1", "A", "body a");
  const n2 = note("n2", "B", "body b");
  const store = new TestStore();
  const llm = new FakeLlm();
  const compiler = makeCompiler(() => [n1, n2], store, llm);
  await compiler.compile();
  const extractBefore = llm.extractCalls;
  const pagesBefore = llm.pageCalls.length;
  const summary = await compiler.compile();
  assert.equal(summary.generated, 0);
  assert.equal(summary.skippedUnchanged, 2);
  assert.equal(summary.pages, 3);
  assert.equal(llm.extractCalls, extractBefore);
  assert.equal(llm.pageCalls.length, pagesBefore);
});

test("long notes are pre-segmented into bounded extraction prompts", async () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ` + "x".repeat(40)).join("\n");
  assert.ok(body.length > 18_000);
  const store = new TestStore();
  const llm = new FakeLlm();
  await makeCompiler(() => [note("n1", "Big", body)], store, llm).compile();
  assert.ok(llm.extractCalls > 1, `expected segmented calls, got ${llm.extractCalls}`);
  for (const prompt of llm.extractPrompts) {
    assert.ok(prompt.length <= 12_100, `prompt too long: ${prompt.length}`);
  }
  assert.ok(store.pages.has("Concept n1"));
});

test("page generation runs with bounded concurrency and a single writer", async () => {
  const notes = Array.from({ length: 4 }, (_, i) => note(`n${i}`, `N${i}`, `body ${i}`));
  const store = new TestStore();
  const llm = new FakeLlm({ delayMs: 20, extract: extractDistinct });
  await makeCompiler(() => notes, store, llm, {
    budget: { pageConcurrency: 4 },
  }).compile();
  assert.ok(llm.maxPageInFlight >= 2, `max in flight ${llm.maxPageInFlight}`);
  assert.equal(store.maxSaveConcurrency, 1);
});

function extractDistinct(user: string): string {
  const ids = [...new Set([...user.matchAll(/NOTE id=(\S+)/g)].map((m) => m[1]))];
  return JSON.stringify(
    ids.map((id) => ({
      name: `Page ${id}`,
      kind: "concept",
      summary: `Summary ${id}`,
      sourceNoteIds: [id],
    })),
  );
}

test("failed pages are recorded and retried on the next compile", async () => {
  const store = new TestStore();
  let attempt = 0;
  const llm = new FakeLlm({
    extract: () =>
      JSON.stringify([{ name: "Bad", kind: "concept", summary: "s", sourceNoteIds: ["n1"] }]),
    page: () => {
      attempt++;
      return attempt === 1
        ? JSON.stringify({ title: "Bad", body: "stub" })
        : defaultPage("Bad");
    },
  });
  const compiler = makeCompiler(() => [note("n1", "N", "body")], store, llm);
  const first = await compiler.compile();
  assert.equal(first.uncollected, 1);
  assert.ok(store.state.failedPages.includes("Bad"));
  assert.equal(store.pages.has("Bad"), false);
  const second = await compiler.compile();
  assert.equal(second.generated, 2); // Bad page + overview
  assert.ok(store.pages.has("Bad"));
});

test("maxPagesPerRun leaves the tail in pendingPages and resumes next run", async () => {
  const notes = [note("n1", "A", "body a"), note("n2", "B", "body b")];
  const store = new TestStore();
  const llm = new FakeLlm({ extract: extractDistinct });
  const compiler = makeCompiler(() => notes, store, llm, {
    budget: { maxPagesPerRun: 1, pageConcurrency: 1 },
  });
  const first = await compiler.compile();
  assert.equal(first.pendingPages, 1);
  assert.deepEqual(store.state.pendingPages.length, 1);
  const second = await compiler.compile();
  assert.equal(second.pendingPages, 0);
  assert.ok(store.pages.has("Page n1"));
  assert.ok(store.pages.has("Page n2"));
});

test("changed sources trigger a revision prompt instead of a full rewrite", async () => {
  let body = "original body";
  const store = new TestStore();
  const llm = new FakeLlm({
    extract: () =>
      JSON.stringify([{ name: "Topic", kind: "concept", summary: "s", sourceNoteIds: ["n1"] }]),
  });
  const compiler = makeCompiler(
    () => [note("n1", "N", body, body === "original body" ? 1000 : 2000)],
    store,
    llm,
  );
  await compiler.compile();
  body = "updated body";
  await compiler.compile();
  const revisionPrompt = llm.pagePrompts[llm.pagePrompts.length - 1];
  // The last page call may be the overview; find the Topic prompt explicitly.
  const topicPrompt = llm.pagePrompts.filter((p) => p.includes("Name: Topic")).pop()!;
  assert.match(topicPrompt, /REVISION MODE/);
  assert.match(topicPrompt, /updated body/);
  assert.ok(revisionPrompt.length > 0);
});

test("page prompts quote at most 12 sources and stay within the hard cap", async () => {
  const notes = Array.from({ length: 20 }, (_, i) =>
    note(`n${i}`, `N${i}`, `body ${i} ` + "y".repeat(5000)),
  );
  const store = new TestStore();
  const llm = new FakeLlm({
    extract: () =>
      JSON.stringify([
        {
          name: "Big",
          kind: "concept",
          summary: "one concept",
          sourceNoteIds: notes.map((n) => n.id),
        },
      ]),
  });
  await makeCompiler(() => notes, store, llm, {
    budget: { pageConcurrency: 1 },
  }).compile();
  const prompt = llm.pagePrompts.find((p) => p.includes("Name: Big"))!;
  assert.ok(prompt.length <= 32_000, `prompt ${prompt.length}`);
  assert.match(prompt, /8 older source notes are omitted/);
});

test("an already-aborted signal rejects without calling the LLM", async () => {
  const controller = new AbortController();
  controller.abort();
  const store = new TestStore();
  const llm = new FakeLlm();
  await assert.rejects(
    () =>
      makeCompiler(() => [note("n1", "N", "body")], store, llm, {
        signal: controller.signal,
      }).compile(),
    (e: Error) => e.name === "AbortError",
  );
  assert.equal(llm.extractCalls, 0);
});

test("chunkText is line-aligned and bounded", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkText(text, 20);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 20);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(chunkText("short", 20), ["short"]);
  assert.ok(MAX_BATCH_NOTES === 40);
});
