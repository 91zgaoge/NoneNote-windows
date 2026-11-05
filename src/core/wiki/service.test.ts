import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_MAX_PAGES_PER_RUN,
  WikiAlreadyRunningError,
  WikiCompileService,
  WikiNotConfiguredError,
  WikiScheduler,
  autoCompileDue,
  localDayKey,
  type SchedulerService,
  type SchedulerSettings,
} from "./service.ts";
import { MemoryWikiStore } from "./compiler.ts";
import type { LlmClient, LlmUsage } from "../ai/client.ts";
import type { AppSettings, Note } from "../types.ts";
import { emptySettings } from "../types.ts";

const USAGE: LlmUsage = { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 };

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  const base = emptySettings();
  return {
    ...base,
    profiles: [{ ...base.profiles[0], baseUrl: "http://ai.local", model: "m" }],
    ...patch,
  };
}

function note(id: string): Note {
  return {
    id,
    title: id,
    body: `body ${id}`,
    color: 0,
    created: 1,
    modified: 1,
    archived: false,
    pinned: false,
    order: 0,
  };
}

class FakeLlm implements LlmClient {
  async chat(system: string, user: string): Promise<string> {
    const [text] = await this.chatWithUsage(system, user);
    return text;
  }
  async chatWithUsage(system: string, user: string): Promise<[string, LlmUsage]> {
    if (system.includes("extract the key concepts")) {
      const ids = [...new Set([...user.matchAll(/NOTE id=(\S+)/g)].map((m) => m[1]))];
      return [
        JSON.stringify(
          ids.map((id) => ({
            name: `Page ${id}`,
            kind: "concept",
            summary: `s ${id}`,
            sourceNoteIds: [id],
          })),
        ),
        USAGE,
      ];
    }
    if (system.includes("overview index")) {
      return [JSON.stringify({ title: "Overview", body: "# Overview" }), USAGE];
    }
    const name = /Name: (.+)/.exec(user)?.[1] ?? "Page";
    return [
      JSON.stringify({
        title: name,
        body: `# ${name}\nA substantial page about ${name} with enough detail to be useful. See also [[overview]].`,
      }),
      USAGE,
    ];
  }
}

test("autoCompileDue is one run per local day at the configured time", () => {
  const at = (h: number, m: number, day = 5) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  const base = settingsWith({
    wikiAutoCompile: true,
    wikiAutoCompileMinutes: 8 * 60,
  });
  assert.equal(autoCompileDue(base, at(7, 59)), false);
  assert.equal(autoCompileDue(base, at(8, 0)), true);
  const ran = { ...base, wikiAutoCompileLastDay: localDayKey(at(8, 0)) };
  assert.equal(autoCompileDue(ran, at(9, 0)), false);
  assert.equal(autoCompileDue(ran, at(8, 0, 6)), true);
  assert.equal(autoCompileDue({ ...base, wikiAutoCompile: false }, at(9, 0)), false);
  assert.equal(
    autoCompileDue(
      { ...base, profiles: [{ ...base.profiles[0], model: "" }] },
      at(9, 0),
    ),
    false,
  );
});

class FakeSchedulerSettings implements SchedulerSettings {
  value: AppSettings;
  constructor(value: AppSettings) {
    this.value = value;
  }
  get(): AppSettings {
    return this.value;
  }
  async update(patch: Partial<AppSettings>): Promise<void> {
    this.value = { ...this.value, ...patch };
  }
}

test("scheduler compiles at most once per local day", async () => {
  let now = new Date(2026, 10, 5, 8, 0, 0, 0).getTime();
  const settings = new FakeSchedulerSettings(
    settingsWith({ wikiAutoCompile: true, wikiAutoCompileMinutes: 8 * 60 }),
  );
  let calls = 0;
  const service: SchedulerService = {
    running: () => false,
    async compile() {
      calls++;
      return {
        pages: 0,
        generated: 0,
        skippedUnchanged: 0,
        orphansRemoved: 0,
        uncollected: 0,
        pendingPages: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        durationMs: 1,
      };
    },
  };
  const scheduler = new WikiScheduler(service, settings, () => now);
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(settings.value.wikiAutoCompileLastDay, "2026-11-05");
  await scheduler.tick();
  assert.equal(calls, 1);
  now = new Date(2026, 10, 6, 8, 0, 0, 0).getTime();
  await scheduler.tick();
  assert.equal(calls, 2);
});

test("service rejects when AI is not configured or a run is already active", async () => {
  const store = new MemoryWikiStore();
  const notConfigured = new WikiCompileService({
    notes: () => [note("n1")],
    wikiStore: store,
    settings: () => emptySettings(),
    transport: { request: async () => ({ status: 200, headers: {}, body: "{}" }) },
  });
  await assert.rejects(
    () => notConfigured.compile(),
    (e: Error) => e instanceof WikiNotConfiguredError,
  );

  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: LlmClient = {
    async chat() {
      await gate;
      return "";
    },
    async chatWithUsage() {
      await gate;
      return ["", USAGE];
    },
  };
  const running = new WikiCompileService({
    notes: () => [note("n1")],
    wikiStore: new MemoryWikiStore(),
    settings: () => settingsWith(),
    transport: { request: async () => ({ status: 200, headers: {}, body: "{}" }) },
    clientFactory: () => slow,
  });
  const first = running.compile();
  await assert.rejects(
    () => running.compile(),
    (e: Error) => e instanceof WikiAlreadyRunningError,
  );
  release!();
  await first;
});

test("background compiles use the fixed 60-page budget, not the manual setting", async () => {
  const store = new MemoryWikiStore();
  const settings = settingsWith({ wikiMaxPagesPerRun: 1 });
  const service = new WikiCompileService({
    notes: () => [note("n1"), note("n2")],
    wikiStore: store,
    settings: () => settings,
    transport: { request: async () => ({ status: 200, headers: {}, body: "{}" }) },
    clientFactory: () => new FakeLlm(),
  });
  const summary = await service.compile({ background: true });
  assert.equal(summary.pendingPages, 0);
  assert.equal(store.pages.size, 3); // two concepts + overview
  assert.equal(BACKGROUND_MAX_PAGES_PER_RUN, 60);

  const manualStore = new MemoryWikiStore();
  const manual = new WikiCompileService({
    notes: () => [note("n1"), note("n2")],
    wikiStore: manualStore,
    settings: () => settings,
    transport: { request: async () => ({ status: 200, headers: {}, body: "{}" }) },
    clientFactory: () => new FakeLlm(),
  });
  const manualSummary = await manual.compile({ background: false });
  assert.equal(manualSummary.pendingPages, 1);
});
