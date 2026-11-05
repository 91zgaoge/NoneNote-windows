import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatNotConfiguredError, ChatService } from "./service.ts";
import { ChatSessionStore } from "./store.ts";
import type { ChatSession } from "./types.ts";
import type { LlmClient, LlmUsage } from "../ai/client.ts";
import type { AppSettings, WikiPage } from "../types.ts";
import { emptySettings } from "../types.ts";

const USAGE: LlmUsage = { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0 };

class RecordingLlm implements LlmClient {
  system = "";
  user = "";
  calls = 0;
  answer = "  Answer from notes. ";

  async chat(system: string, user: string): Promise<string> {
    this.calls++;
    this.system = system;
    this.user = user;
    return this.answer;
  }
  async chatWithUsage(system: string, user: string): Promise<[string, LlmUsage]> {
    return [await this.chat(system, user), USAGE];
  }
}

const pages: WikiPage[] = [
  {
    name: "Coroutines",
    title: "Coroutines",
    kind: "concept",
    body: "Structured concurrency with launch and async.",
    sourceNoteIds: ["n1"],
    updatedAt: 1,
  },
];

function settings(): AppSettings {
  const base = emptySettings();
  return {
    ...base,
    profiles: [{ ...base.profiles[0], baseUrl: "http://ai.local", model: "m" }],
  };
}

function deps(llm: LlmClient) {
  return {
    notes: () => [
      {
        id: "n1",
        title: "Coroutine notes",
        body: "launch builds a coroutine",
        color: 0,
        created: 1,
        modified: 1,
        archived: false,
        pinned: false,
        order: 0,
      },
    ],
    pages: async () => pages,
    settings,
    transport: { request: async () => ({ status: 200, headers: {}, body: "{}" }) },
    clientFactory: () => llm,
    now: () => 1000,
  };
}

const emptySession: ChatSession = { id: "s1", title: "", messages: [], updatedAt: 0 };

test("chat grounds the prompt in retrieved pages and appends the answer", async () => {
  const llm = new RecordingLlm();
  const service = new ChatService(deps(llm));
  const result = await service.send(emptySession, "how do coroutines work?");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].content, "Answer from notes.");
  assert.equal(result.title, "how do coroutines work?");
  assert.deepEqual(result.messages[1].sources, ["Coroutines"]);
  assert.match(llm.system, /second-brain assistant/);
  assert.match(llm.user, /Structured concurrency/);
  assert.ok(llm.user.trimEnd().endsWith("Question: how do coroutines work?"));
});

test("follow-up questions include recent conversation before the question", async () => {
  const llm = new RecordingLlm();
  const service = new ChatService(deps(llm));
  const first = await service.send(emptySession, "what is launch?");
  const second = await service.send(first, "and async?");
  assert.match(llm.user, /Conversation so far:/);
  assert.match(llm.user, /User: what is launch\?/);
  assert.ok(llm.user.trimEnd().endsWith("Question: and async?"));
  assert.equal(second.messages.length, 4);
});

test("chat auto-runs create/append/color and gates archive/delete", async () => {
  const llm = new RecordingLlm();
  llm.answer =
    "Done.\n```noty\n" +
    '[{"action":"create","title":"New","body":"body"},' +
    '{"action":"archive","title":"Coroutine notes"}]\n```\n';
  const calls: string[] = [];
  const executor = {
    create(body: string, title?: string) {
      calls.push(`create:${title}:${body}`);
      return {
        id: "n9",
        title: title ?? "",
        body,
        color: 0,
        created: 1,
        modified: 1,
        archived: false,
        pinned: false,
        order: 0,
      };
    },
    append() {
      calls.push("append");
    },
    setColor() {
      calls.push("color");
    },
    setDue() {
      calls.push("due");
    },
    archive(id: string, archived: boolean) {
      calls.push(`archive:${id}:${archived}`);
    },
    remove() {
      calls.push("remove");
    },
  };
  const service = new ChatService({ ...deps(llm), actions: executor });
  const result = await service.send(emptySession, "create New and archive Coroutine notes");
  assert.equal(result.messages[1].content, "Done.");
  const actions = result.messages[1].actions!;
  assert.equal(actions.length, 2);
  assert.equal(actions[0].kind, "create");
  assert.equal(actions[0].status, "done");
  assert.equal(actions[1].kind, "archive");
  assert.equal(actions[1].status, "pending");
  assert.equal(actions[1].targetId, "n1");

  const confirmed = await service.confirmAction(actions[1]);
  assert.equal(confirmed.status, "done");
  assert.ok(calls.includes("archive:n1:true"));
});

test("the memory profile precedes retrieved material and the question stays last", async () => {
  const llm = new RecordingLlm();
  const service = new ChatService({
    ...deps(llm),
    memoryBlock: () => "About the user:\n- Likes tea",
  });
  await service.send(emptySession, "what do I like?");
  assert.ok(llm.user.startsWith("About the user:"));
  assert.match(llm.user, /Structured concurrency/);
  assert.ok(llm.user.trimEnd().endsWith("Question: what do I like?"));
});

test("unconfigured chat throws a typed error without calling the model", async () => {
  let called = false;
  const service = new ChatService({
    ...deps({
      async chat() {
        called = true;
        return "";
      },
      async chatWithUsage() {
        called = true;
        return ["", USAGE];
      },
    }),
    settings: () => emptySettings(),
  });
  await assert.rejects(
    () => service.send(emptySession, "hello"),
    (e: Error) => e instanceof ChatNotConfiguredError,
  );
  assert.equal(called, false);
});

test("chat session store persists and filters invalid rows", async () => {
  const values = new Map<string, string>();
  const storage = {
    async load<T>(key: string): Promise<T | null> {
      const raw = values.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async save(key: string, value: unknown): Promise<void> {
      values.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      values.delete(key);
    },
  };
  const store = new ChatSessionStore(storage);
  await store.save([emptySession, { id: 1 } as unknown as ChatSession]);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "s1");
});
