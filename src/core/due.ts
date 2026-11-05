export type DueState = "overdue" | "today" | "future";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day, yyyy-MM-dd. */
export function todayLocal(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function isValidDueDate(date: string | null | undefined): boolean {
  return !!date && ISO_DATE.test(date);
}

/** Overdue / today / future, or null when the date is absent/invalid. */
export function dueState(
  date: string | null | undefined,
  today = todayLocal(),
): DueState | null {
  if (!isValidDueDate(date)) return null;
  if (date! < today) return "overdue";
  if (date === today) return "today";
  return "future";
}
