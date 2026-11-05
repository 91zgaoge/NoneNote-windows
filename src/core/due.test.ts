import { test } from "node:test";
import assert from "node:assert/strict";
import { dueState, isValidDueDate, todayLocal } from "./due.ts";

test("dueState classifies overdue/today/future and rejects junk", () => {
  assert.equal(dueState("2026-11-04", "2026-11-05"), "overdue");
  assert.equal(dueState("2026-11-05", "2026-11-05"), "today");
  assert.equal(dueState("2026-11-06", "2026-11-05"), "future");
  assert.equal(dueState(null, "2026-11-05"), null);
  assert.equal(dueState("tomorrow", "2026-11-05"), null);
});

test("isValidDueDate only accepts yyyy-MM-dd", () => {
  assert.equal(isValidDueDate("2026-11-05"), true);
  assert.equal(isValidDueDate("2026-1-5"), false);
  assert.equal(isValidDueDate(""), false);
});

test("todayLocal formats a local calendar day", () => {
  const ms = new Date(2026, 10, 5, 23, 59).getTime();
  assert.equal(todayLocal(ms), "2026-11-05");
});
