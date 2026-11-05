import type { MemoryFact } from "./types.ts";
import { isExpired } from "./ops.ts";

export const STATIC_CAP = 12;
export const DYNAMIC_CAP = 8;
export const INFERRED_CAP = 2;
export const MAX_BLOCK_CHARS = 1_200;
export const RECENT_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface MemoryProfileData {
  staticFacts: string[];
  dynamicFacts: string[];
  inferred: string[];
}

/**
 * "About the user" block injected into every second-brain ask. Static facts
 * rank by corroboration (cap 12); dynamic facts must be fresh (14 days, cap 8)
 * and carry a date; inferred facts never enter the profile unless the question
 * matches (cap 2, "(inferred)" suffix). Computed at read time.
 */
export function synthesizeProfile(
  facts: MemoryFact[],
  now: number,
  today: string,
  question = "",
  dateFmt: (ms: number) => string = defaultDate,
): MemoryProfileData {
  const live = facts.filter(
    (f) => f.isLatest && !f.forgotten && !isExpired(f.forgetAfter, today),
  );
  const seen = new Set<string>();
  const fresh = (text: string): boolean => {
    const norm = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  };

  const statics = live
    .filter((f) => !f.isInference && f.kind === "static")
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .map((f) => f.fact.trim())
    .filter(fresh)
    .slice(0, STATIC_CAP);

  const dynamics = live
    .filter(
      (f) =>
        !f.isInference && f.kind === "dynamic" && now - f.updatedAt <= RECENT_WINDOW_MS,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((f) => fresh(f.fact))
    .slice(0, DYNAMIC_CAP)
    .map((f) => `(${dateFmt(f.updatedAt)}) ${f.fact.trim()}`);

  const terms = questionTerms(question);
  const inferred =
    terms.length === 0
      ? []
      : live
          .filter((f) => f.isInference)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .filter(
            (f) =>
              fresh(f.fact) &&
              terms.some((term) => f.fact.toLowerCase().includes(term)),
          )
          .slice(0, INFERRED_CAP)
          .map((f) => `${f.fact.trim()} (inferred)`);

  return { staticFacts: statics, dynamicFacts: dynamics, inferred };
}

/** Renders the prompt block; empty string when there is nothing worth injecting. */
export function formatProfile(
  profile: MemoryProfileData,
  maxChars = MAX_BLOCK_CHARS,
): string {
  let out = "About the user:\n";
  let lines = 0;
  const add = (line: string): boolean => {
    if (out.length + line.length + 1 > maxChars) return false;
    out += line + "\n";
    lines++;
    return true;
  };
  for (const f of profile.staticFacts) if (!add(`- ${f}`)) break;
  for (const f of profile.dynamicFacts) if (!add(`- ${f}`)) break;
  for (const f of profile.inferred) if (!add(`- ${f}`)) break;
  return lines === 0 ? "" : out.trimEnd();
}

/** Latin words of 3+ chars and CJK bigrams (containment works for names). */
export function questionTerms(question: string): string[] {
  const q = question.toLowerCase();
  const latin = [...q.matchAll(/[a-z0-9]{3,}/g)].map((m) => m[0]);
  const bigrams: string[] = [];
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) bigrams.push(run.slice(i, i + 2));
  }
  return [...latin, ...bigrams];
}

function defaultDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
