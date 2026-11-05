import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, isValidEventTime } from "./event.ts";

test("timed events use floating local start and a one-hour end", () => {
  const ics = buildIcs("Dentist", "2026-12-01", "09:30", new Date("2026-11-05T01:00:00Z"));
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Dentist/);
  assert.match(ics, /DTSTART:20261201T093000/);
  assert.match(ics, /DTEND:20261201T103000/);
  assert.match(ics, /DTSTAMP:20261105T010000Z/);
});

test("date-only events are all-day with the next day as end", () => {
  const ics = buildIcs("Trip", "2026-12-31");
  assert.match(ics, /DTSTART;VALUE=DATE:20261231/);
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
});

test("event time validation and escaping", () => {
  assert.equal(isValidEventTime("09:30"), true);
  assert.equal(isValidEventTime("24:00"), false);
  assert.equal(isValidEventTime(null), false);
  const ics = buildIcs("A, B; C", "2026-12-01");
  assert.match(ics, /SUMMARY:A\\, B\\; C/);
});
