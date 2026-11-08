import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeAgentAction,
  parseAgentActions,
  resolveAgentActions,
  type NoteActionExecutor,
} from "./actions.ts";
import type { Note } from "../types.ts";

function note(id: string, title: string, body = ""): Note {
  return {
    id,
    title,
    body,
    color: 0,
    created: 1,
    modified: 1,
    archived: false,
    pinned: false,
    order: 0,
  };
}

test("parses a fenced action and strips it from the prose", () => {
  const answer =
    'Sure, I made it.\n```noty\n{"action":"create","title":"Groceries","body":"milk"}\n```\n';
  const parsed = parseAgentActions(answer);
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].kind, "create");
  assert.equal(parsed.actions[0].title, "Groceries");
  assert.equal(parsed.actions[0].text, "milk");
  assert.equal(parsed.cleanedText, "Sure, I made it.");
});

test("accepts arrays and color names; malformed fences stay visible", () => {
  const answer =
    '```noty\n[{"action":"color","title":"A","color":"Sky"},{"action":"archive","title":"B"}]\n```\n' +
    'oops\n```noty\n{not json}\n```';
  const parsed = parseAgentActions(answer);
  assert.deepEqual(parsed.actions.map((a) => a.kind), ["color", "archive"]);
  assert.equal(parsed.actions[0].color, 4);
  assert.match(parsed.cleanedText, /not json/);
});

test("resolves targets by id or exact title and rejects ambiguity", () => {
  const notes = [note("n1", "Groceries"), note("n2", "Dup"), note("n3", "Dup")];
  const [ok, ambiguous, missing, badColor] = resolveAgentActions(
    [
      { kind: "append", title: "groceries", text: "milk", status: "pending" },
      { kind: "archive", title: "Dup", status: "pending" },
      { kind: "delete", title: "Nope", status: "pending" },
      { kind: "color", id: "n1", status: "pending" },
    ],
    notes,
  );
  assert.equal(ok.status, "pending");
  assert.equal(ok.targetId, "n1");
  assert.equal(ambiguous.status, "failed");
  assert.equal(ambiguous.fail, "ambiguous");
  assert.equal(missing.status, "failed");
  assert.equal(missing.fail, "not_found");
  assert.equal(badColor.status, "failed");
  assert.equal(badColor.fail, "bad_color");
});

test("calendar events need a title, date and optional valid time", () => {
  const parsed = parseAgentActions(
    '```noty\n{"action":"event","title":"Dentist","date":"2026-12-01","time":"09:30"}\n```',
  );
  assert.equal(parsed.actions[0].kind, "event");
  assert.equal(parsed.actions[0].dueOn, "2026-12-01");
  assert.equal(parsed.actions[0].time, "09:30");
  const [ok, badDate, badTime] = resolveAgentActions(
    [
      { kind: "event", title: "Dentist", dueOn: "2026-12-01", time: "09:30", status: "pending" },
      { kind: "event", title: "Dentist", dueOn: "soon", status: "pending" },
      { kind: "event", title: "Dentist", dueOn: "2026-12-01", time: "25:00", status: "pending" },
    ],
    [],
  );
  assert.equal(ok.status, "pending");
  assert.equal(badDate.fail, "bad_date");
  assert.equal(badTime.fail, "bad_time");
});

test("due actions need an ISO date", () => {
  const [ok, bad] = resolveAgentActions(
    [
      { kind: "due", title: "Groceries", dueOn: "2026-12-01", status: "pending" },
      { kind: "due", title: "Groceries", dueOn: "tomorrow", status: "pending" },
    ],
    [note("n1", "Groceries")],
  );
  assert.equal(ok.status, "pending");
  assert.equal(bad.status, "failed");
  assert.equal(bad.fail, "bad_date");
});

test("executes create/append/color/due/archive/delete through the seam", () => {
  const notes = [note("n1", "Groceries", "milk")];
  const calls: string[] = [];
  const executor: NoteActionExecutor = {
    createDiagram(title) {
    return { id: "d1", title, body: "", color: 0, created: 0, modified: 0, archived: false, pinned: false, order: 0 };
  },
  create(body, title) {
      calls.push(`create:${title}:${body}`);
      return note("n9", title ?? "", body);
    },
    append(id, text) {
      calls.push(`append:${id}:${text}`);
    },
    setColor(id, color) {
      calls.push(`color:${id}:${color}`);
    },
    setDue(id, date) {
      calls.push(`due:${id}:${date}`);
    },
    addEvent(title, date, time) {
      calls.push(`event:${title}:${date}:${time ?? ""}`);
    },
    archive(id, archived) {
      calls.push(`archive:${id}:${archived}`);
    },
    remove(id) {
      calls.push(`remove:${id}`);
    },
  };
  const resolved = resolveAgentActions(
    [
      { kind: "create", title: "New", text: "body", status: "pending" },
      { kind: "append", id: "n1", text: "eggs", status: "pending" },
      { kind: "color", id: "n1", color: 4, status: "pending" },
      { kind: "due", id: "n1", dueOn: "2026-12-01", status: "pending" },
      { kind: "archive", id: "n1", status: "pending" },
      { kind: "delete", id: "n1", status: "pending" },
    ],
    notes,
  );
  const done = resolved.map((a) => executeAgentAction(a, notes, executor));
  assert.deepEqual(
    done.map((a) => a.status),
    ["done", "done", "done", "done", "done", "done"],
  );
  assert.deepEqual(calls, [
    "create:New:body",
    "append:n1:eggs",
    "color:n1:4",
    "due:n1:2026-12-01",
    "archive:n1:true",
    "remove:n1",
  ]);
  assert.equal(done[0].targetTitle, "New");
});
