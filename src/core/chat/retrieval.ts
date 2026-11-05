import type { Note, WikiPage } from "../types.ts";
import type { RetrievalChunk } from "./types.ts";

export interface RetrievalOptions {
  maxPages: number;
  maxNotes: number;
  pageChars: number;
  noteChars: number;
  totalChars: number;
}

export const DEFAULT_RETRIEVAL: RetrievalOptions = {
  maxPages: 6,
  maxNotes: 4,
  pageChars: 2_000,
  noteChars: 1_200,
  totalChars: 12_000,
};

/**
 * Tokenizer for mixed English/CJK text: ASCII words plus overlapping CJK
 * bigrams (single characters when a run is one char). No external index.
 */
export function queryTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+/g)) out.push(m[0]);
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function scoreText(title: string, body: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerTitle.includes(term)) score += 4;
    let from = 0;
    let hits = 0;
    while (hits < 8) {
      const at = lowerBody.indexOf(term, from);
      if (at < 0) break;
      hits++;
      from = at + term.length;
    }
    score += hits;
  }
  return score;
}

/**
 * Term-overlap retrieval over compiled wiki pages and raw notes. Pages rank
 * first because they are already synthesized; notes fill gaps (fresh notes
 * the wiki has not compiled yet). Results are bounded by [options.totalChars].
 */
export function retrieve(
  question: string,
  pages: WikiPage[],
  notes: Note[],
  options: Partial<RetrievalOptions> = {},
): RetrievalChunk[] {
  const opts = { ...DEFAULT_RETRIEVAL, ...options };
  const terms = queryTokens(question);
  if (terms.length === 0) return [];

  const pageHits = pages
    .map((p) => ({ p, score: scoreText(p.title || p.name, p.body, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.updatedAt - a.p.updatedAt)
    .slice(0, opts.maxPages)
    .map<RetrievalChunk>(({ p, score }) => ({
      kind: "page",
      name: p.title || p.name,
      text: p.body,
      score,
    }));

  const noteHits = notes
    .filter((n) => !n.archived)
    .map((n) => ({ n, score: scoreText(n.title, n.body, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n.modified - a.n.modified)
    .slice(0, opts.maxNotes)
    .map<RetrievalChunk>(({ n, score }) => ({
      kind: "note",
      name: n.title || n.body.split(/\r?\n/)[0]?.slice(0, 40) || n.id,
      text: n.body,
      score,
    }));

  const out: RetrievalChunk[] = [];
  let used = 0;
  for (const chunk of [...pageHits, ...noteHits]) {
    const cap = chunk.kind === "page" ? opts.pageChars : opts.noteChars;
    const room = opts.totalChars - used;
    if (room <= 0) break;
    const text = chunk.text.slice(0, Math.min(cap, room));
    out.push({ ...chunk, text });
    used += text.length;
  }
  return out;
}

/** Stable rendering of retrieved chunks for the prompt; question stays last. */
export function renderContext(chunks: RetrievalChunk[]): string {
  let out = "Relevant material from the user's notes:\n";
  for (const chunk of chunks) {
    const label = chunk.kind === "page" ? "wiki page" : "note";
    out += `\n--- ${label}: ${chunk.name.replace(/\n/g, " ")} ---\n${chunk.text}\n`;
  }
  return out;
}
