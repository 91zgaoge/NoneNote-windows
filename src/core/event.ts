import { isValidDueDate } from "./due.ts";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidEventTime(time: string | null | undefined): boolean {
  return !!time && TIME.test(time);
}

function compact(date: string): string {
  return date.replace(/-/g, "");
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/**
 * Minimal RFC 5545 event. Timed events use a floating local time and a
 * one-hour duration; date-only events are all-day. Windows hands the file to
 * the user's calendar app (Android opens the calendar insert UI directly).
 */
export function buildIcs(
  title: string,
  date: string,
  time?: string | null,
  now = new Date(),
): string {
  if (!isValidDueDate(date)) throw new Error("invalid event date");
  const timed = isValidEventTime(time);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const uid = `${compact(date)}-${Math.random().toString(36).slice(2)}@nonenote`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NoneNote//Windows//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeIcs(title)}`,
  ];
  if (timed) {
    const hhmm = time!.replace(":", "");
    const endHour = (Number(time!.slice(0, 2)) + 1) % 24;
    const end = `${String(endHour).padStart(2, "0")}${time!.slice(3)}`;
    lines.push(`DTSTART:${compact(date)}T${hhmm}00`);
    lines.push(`DTEND:${compact(date)}T${end}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compact(date)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDay(date)}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}
