import { test } from "node:test";
import assert from "node:assert/strict";
import { DUE_REMINDER_MINUTES_OF_DAY, dueTodayNotes, localDay, shouldFireDueReminder } from "./dueReminder.ts";
import { dueState } from "./due.ts";
import type { Note } from "./types.ts";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  title: "T",
  body: "body",
  color: 0,
  created: 1000,
  modified: 2000,
  archived: false,
  pinned: false,
  order: 0,
  ...over,
});

const notes: Note[] = [
  note({ id: "due-active" }),
  note({ id: "due-archived", archived: true }),
  note({ id: "due-other-day" }),
  note({ id: "undated" }),
];

test("dueTodayNotes keeps only unarchived notes due today", () => {
  const dueOns = {
    "due-active": "2026-11-05",
    "due-archived": "2026-11-05",
    "due-other-day": "2026-11-06",
  };
  const got = dueTodayNotes(notes, dueOns, "2026-11-05");
  assert.deepEqual(
    got.map((n) => n.id),
    ["due-active"],
  );
  // Archived exclusion does not depend on the date matching.
  assert.deepEqual(dueTodayNotes(notes, { "due-archived": "2026-11-05" }, "2026-11-05"), []);
  // Unknown/undated notes and empty maps say nothing.
  assert.deepEqual(dueTodayNotes(notes, {}, "2026-11-05"), []);
});

test("dueState classifies lexicographically (re-exported from due.ts)", () => {
  assert.equal(dueState("2026-11-04", "2026-11-05"), "overdue");
  assert.equal(dueState("2026-11-05", "2026-11-05"), "today");
  assert.equal(dueState("2026-11-06", "2026-11-05"), "future");
});

test("DUE_REMINDER_MINUTES_OF_DAY is 08:30", () => {
  assert.equal(DUE_REMINDER_MINUTES_OF_DAY, 8 * 60 + 30);
  assert.equal(DUE_REMINDER_MINUTES_OF_DAY, 510);
});

test("shouldFireDueReminder stays quiet before 08:30", () => {
  const at829 = new Date(2026, 10, 5, 8, 29, 59).getTime();
  assert.equal(shouldFireDueReminder(at829, ""), false);
  const at730 = new Date(2026, 10, 5, 7, 30).getTime();
  assert.equal(shouldFireDueReminder(at730, ""), false);
});

test("shouldFireDueReminder fires at and after 08:30", () => {
  const at830 = new Date(2026, 10, 5, 8, 30, 0).getTime();
  assert.equal(shouldFireDueReminder(at830, ""), true);
  const at915 = new Date(2026, 10, 5, 9, 15).getTime();
  assert.equal(shouldFireDueReminder(at915, ""), true);
  const at2359 = new Date(2026, 10, 5, 23, 59).getTime();
  assert.equal(shouldFireDueReminder(at2359, ""), true);
});

test("shouldFireDueReminder fires once per local day", () => {
  const at830 = new Date(2026, 10, 5, 8, 30).getTime();
  const at915 = new Date(2026, 10, 5, 9, 15).getTime();
  // The caller persists localDay(at830) after firing.
  assert.equal(shouldFireDueReminder(at915, localDay(at830)), false);
  const at2359 = new Date(2026, 10, 5, 23, 59).getTime();
  assert.equal(shouldFireDueReminder(at2359, "2026-11-05"), false);
});

test("shouldFireDueReminder re-fires the next day at/after 08:30", () => {
  const next829 = new Date(2026, 10, 6, 8, 29).getTime();
  assert.equal(shouldFireDueReminder(next829, "2026-11-05"), false);
  const next830 = new Date(2026, 10, 6, 8, 30).getTime();
  assert.equal(shouldFireDueReminder(next830, "2026-11-05"), true);
  const next1800 = new Date(2026, 10, 6, 18, 0).getTime();
  assert.equal(shouldFireDueReminder(next1800, "2026-11-05"), true);
});

test("localDay formats the local calendar day with zero padding", () => {
  assert.equal(localDay(new Date(2026, 10, 5, 23, 59).getTime()), "2026-11-05");
  assert.equal(localDay(new Date(2026, 10, 5, 0, 0).getTime()), "2026-11-05");
  assert.equal(localDay(new Date(2027, 0, 2, 12, 0).getTime()), "2027-01-02");
  assert.equal(localDay(new Date(2026, 2, 9, 12, 0).getTime()), "2026-03-09");
});
