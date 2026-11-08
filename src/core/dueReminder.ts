import type { Note } from "./types.ts";
import { dueState, todayLocal } from "./due.ts";

/**
 * Note due-date reminder logic — a port of Android's core/DueDates.kt plus
 * the scheduling rules of due/DueReminderWorker.kt: one daily reminder at
 * 08:30 local time for notes whose due date is today, fired once per local
 * day. Pure functions only — the caller owns the notification plugin and
 * persists `localDay(nowMs)` after firing so the same day never re-fires.
 */

/** Minutes-of-day the daily reminder fires at: 08:30 local (Android parity). */
export const DUE_REMINDER_MINUTES_OF_DAY = 8 * 60 + 30;

/** Local calendar day, yyyy-MM-dd (persist after firing). */
export const localDay = todayLocal;

export type { DueState } from "./due.ts";

/**
 * Overdue / today / future by lexicographic yyyy-MM-dd comparison, or null
 * for absent/invalid dates (re-exported from due.ts, shared with the UI).
 */
export { dueState };

/**
 * Notes due exactly on `today` (yyyy-MM-dd), archived excluded — the Android
 * worker's DueDates.dueOn + `filter { !it.archived }`.
 */
export function dueTodayNotes(
  notes: Note[],
  dueOns: Record<string, string>,
  today: string,
): Note[] {
  return notes.filter((n) => !n.archived && dueOns[n.id] === today);
}

/**
 * Whether the daily due reminder should fire at `nowMs`: not already fired
 * on this local day (`lastFiredDay`) and at/after 08:30 local. When it
 * returns true the caller shows the notification and stores
 * `localDay(nowMs)` as the new lastFiredDay.
 */
export function shouldFireDueReminder(nowMs: number, lastFiredDay: string): boolean {
  if (localDay(nowMs) === lastFiredDay) return false;
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes() >= DUE_REMINDER_MINUTES_OF_DAY;
}
