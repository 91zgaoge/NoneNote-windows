import type { Attachment, ConceptState, Note, WikiPage, WikiState } from "../types.ts";
import { emptyWikiState } from "../types.ts";
import type { LlmClient } from "../ai/client.ts";
import * as PromptMetrics from "../ai/promptMetrics.ts";
import { extractJson } from "../ai/jsonExtract.ts";
import { documentProjectionForAi } from "../document.ts";
import { derivedTitle } from "../text.ts";
import { contentHash } from "./text.ts";

export interface WikiStore {
  loadPages(): Promise<WikiPage[]>;
  savePage(page: WikiPage): Promise<void>;
  deletePage(name: string): Promise<void>;
  loadState(): Promise<WikiState>;
  saveState(state: WikiState): Promise<void>;
}

export type Phase = "EXTRACT" | "PAGES";
export const STEP_PREPARE = "prepare";
export const STEP_START = "start";
export const STEP_DONE = "done";

export interface Progress {
  phase: Phase;
  current: number;
  total: number;
  label: string;
  step: string;
  estimatedTokens: number;
  largePrompt: boolean;
}

export interface Summary {
  pages: number;
  generated: number;
  skippedUnchanged: number;
  orphansRemoved: number;
  uncollected: number;
  pendingPages: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  durationMs: number;
}

export interface PromptBudget {
  extractPromptChars: number;
  noteChars: number;
  attachmentChars: number;
  extractSegmentChars: number;
  maxSegmentsPerNote: number;
  pageSourceChars: number;
  pageSourceNotes: number;
  pageConcurrency: number;
  maxPagesPerRun: number;
  linkableChars: number;
  relatedHints: number;
  overviewChars: number;
  hardSystemChars: number;
  hardUserChars: number;
}

export const DEFAULT_BUDGET: PromptBudget = {
  extractPromptChars: 12_000,
  noteChars: 8_000,
  attachmentChars: 4_000,
  extractSegmentChars: 8_000,
  maxSegmentsPerNote: 64,
  pageSourceChars: 12_000,
  pageSourceNotes: 12,
  pageConcurrency: 4,
  maxPagesPerRun: 0,
  linkableChars: 1_500,
  relatedHints: 8,
  overviewChars: 12_000,
  hardSystemChars: 8_000,
  hardUserChars: 32_000,
};

export const OVERVIEW_PAGE = "overview";
export const MIN_PAGE_BODY_CHARS = 80;
export const EXTRACT_MAX_OUTPUT_TOKENS = 1_024;
export const PAGE_MAX_OUTPUT_TOKENS = 2_048;
export const OVERVIEW_MAX_OUTPUT_TOKENS = 2_048;
export const MAX_FAILED_RETRIES = 10;
export const MAX_SUMMARY_CHARS = 400;
export const MIN_NOTE_CHARS = 240;
export const MAX_BATCH_NOTES = 40;
export const MIN_PAGE_NOTE_CHARS = 1_000;

const EXTRACT_SYSTEM =
  "You are a wiki compiler. From the user's personal notes, extract the key concepts " +
  "and entities they discuss. Respond ONLY with a JSON array of " +
  '[{"name":...,"kind":"concept"|"entity","summary":...,"sourceNoteIds":[...]}]. ' +
  'kind is "entity" for concrete people/places/products, "concept" for ideas and topics. ' +
  "Write name and summary in the dominant language of the notes. " +
  "Keep each summary to one sentence, at most 40 concepts total. " +
  "Only cite note ids that appear in the input. No prose, no code fences.";

const PAGE_RULES =
  "Task: write one page of a personal knowledge wiki.\n" +
  "Output: JSON {\"title\":...,\"body\":...}; body is markdown in the dominant " +
  "language of the sources; synthesize rather than quote; keep body under about " +
  "8,000 characters. Link only with [[Page Name]] from the catalog below; never " +
  "link to this page itself.\n";

const PAGE_SYSTEM =
  "You are a wiki compiler writing one page of a personal knowledge wiki. " +
  'Respond ONLY with JSON {"title":...,"body":...}. body is markdown in the dominant ' +
  "language of the source notes. Synthesize; do not just quote. Link to other pages with " +
  "[[Page Name]] using only names from the provided linkable list. " +
  "Keep body under about 8,000 characters; synthesize, do not quote at length. " +
  "Do not add a sources or provenance section; one is appended automatically.";

const OVERVIEW_SYSTEM =
  "You are a wiki compiler writing the overview index of a personal knowledge wiki. " +
  'Respond ONLY with JSON {"title":...,"body":...}. body is markdown in the dominant ' +
  "language of the page summaries: a short orientation paragraph followed by a grouped " +
  "list linking every page as [[Page Name]]. Keep body under about 8,000 characters. " +
  "No prose, no code fences.";

interface Extracted {
  name: string;
  kind: string;
  summary: string;
  sourceNoteIds: string[];
}

interface ExtractSegment {
  note: Note;
  text: string;
  part: number;
  parts: number;
}

interface PageWork {
  index: number;
  concept: ConceptState;
  sources: Note[];
  previous: WikiPage | null;
  revisionSources: Note[];
}

export interface CompilerOptions {
  notesProvider: () => Note[] | Promise<Note[]>;
  llm: LlmClient;
  extractLlm?: LlmClient;
  store: WikiStore;
  now?: () => number;
  budget?: Partial<PromptBudget>;
  sourcesHeading?: string;
  attachmentsProvider?: () => Attachment[] | Promise<Attachment[]>;
  relatedNotesProvider?: (noteId: string) => string[] | Promise<string[]>;
  userInstruction?: string;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

function abortError(): Error {
  const e = new Error("compile aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Compiles all notes into an interlinked markdown wiki with the same
 * incremental/budget/checkpoint semantics as Android's `WikiCompiler`:
 * bounded prompts, 4-way concurrency with a single writer, per-phase output
 * caps, failed-page retries, and resumable `pendingPages`.
 */
export class WikiCompiler {
  private readonly opts: CompilerOptions;
  private readonly budget: PromptBudget;
  private readonly now: () => number;
  private readonly sourcesHeading: string;
  private readonly attachmentsProvider: () => Promise<Attachment[]>;
  private readonly relatedNotesProvider: (id: string) => Promise<string[]>;
  private readonly userInstruction: string;
  private readonly onProgress: (p: Progress) => void;
  private readonly signal?: AbortSignal;

  private promptTokens = 0;
  private completionTokens = 0;
  private cachedPromptTokens = 0;

  constructor(opts: CompilerOptions) {
    this.opts = opts;
    this.budget = { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.sourcesHeading = opts.sourcesHeading ?? "Sources";
    this.attachmentsProvider = async () => opts.attachmentsProvider?.() ?? [];
    this.relatedNotesProvider = async (id) => opts.relatedNotesProvider?.(id) ?? [];
    this.userInstruction = opts.userInstruction ?? "";
    this.onProgress = opts.onProgress ?? (() => {});
    this.signal = opts.signal;
  }

  async compile(): Promise<Summary> {
    const t0 = this.now();
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cachedPromptTokens = 0;

    const notes = await this.opts.notesProvider();
    this.checkAbort();
    this.progress({ phase: "EXTRACT", current: 0, total: notes.length, label: "", step: STEP_PREPARE, estimatedTokens: 0, largePrompt: false });

    const attachmentsByNote = groupByNote(await this.attachmentsProvider());
    const hashes: Record<string, string> = {};
    for (const n of notes) {
      hashes[n.id] = await contentHash(n, attachmentsByNote.get(n.id) ?? []);
    }
    const state = await this.opts.store.loadState();

    const changed = notes.filter((n) => state.noteHashes[n.id] !== hashes[n.id]);
    const deletedIds = new Set(
      Object.keys(state.noteHashes).filter((id) => !(id in hashes)),
    );
    const changedIds = new Set(changed.map((n) => n.id));
    const committedHashes: Record<string, string> = {};
    for (const [id, h] of Object.entries(hashes)) {
      if (!changedIds.has(id)) committedHashes[id] = h;
    }

    const concepts = new Map<string, ConceptState>(
      Object.entries(state.concepts).map(([k, v]) => [k, { ...v }]),
    );
    let skipped = 0;
    let generated = 0;
    let orphans = 0;
    let uncollected = 0;
    const failedNoteIds = new Set<string>();
    const failedPages: string[] = [];

    const checkpoint = async (pending: string[]): Promise<void> => {
      const savedHashes: Record<string, string> = {};
      for (const [id, h] of Object.entries(committedHashes)) {
        if (!failedNoteIds.has(id)) savedHashes[id] = h;
      }
      await this.opts.store.saveState({
        noteHashes: savedHashes,
        concepts: Object.fromEntries(concepts),
        failedPages: [...failedPages],
        pendingPages: pending,
      });
    };

    if (deletedIds.size > 0) {
      for (const [name, c] of [...concepts.entries()]) {
        const remaining = c.sourceNoteIds.filter((id) => !deletedIds.has(id));
        if (remaining.length !== c.sourceNoteIds.length) {
          concepts.set(name, { ...c, sourceNoteIds: remaining });
        }
      }
    }

    if (changed.length > 0) {
      const segments = this.extractSegments(changed, attachmentsByNote);
      const batches = this.batchSegments(segments, this.budget.extractPromptChars);
      const processed = new Set<string>();
      const concurrency = Math.max(1, this.budget.pageConcurrency);
      let start = 0;
      while (start < batches.length) {
        this.checkAbort();
        const end = Math.min(start + concurrency, batches.length);
        const chunk = batches.slice(start, end);
        const results = await Promise.all(
          chunk.map(async (batch, idx) => {
            this.checkAbort();
            const i = start + idx;
            const label = this.segmentLabel(batch);
            try {
              return await this.extractConcepts(batch, (tokens) => {
                this.progress({
                  phase: "EXTRACT",
                  current: i + 1,
                  total: batches.length,
                  label,
                  step: STEP_START,
                  estimatedTokens: tokens,
                  largePrompt: tokens >= PromptMetrics.WARN_TOKENS,
                });
              });
            } catch (e) {
              if (isAbort(e)) throw e;
              return null;
            }
          }),
        );
        results.forEach((extracted, idx) => {
          const i = start + idx;
          const batch = chunk[idx];
          const label = this.segmentLabel(batch);
          const batchIds = new Set(batch.map((s) => s.note.id));
          if (extracted === null) {
            for (const id of batchIds) failedNoteIds.add(id);
          } else {
            const freshIds = new Set([...batchIds].filter((id) => !processed.has(id)));
            for (const [name, c] of [...concepts.entries()]) {
              const remaining = c.sourceNoteIds.filter((id) => !freshIds.has(id));
              if (remaining.length !== c.sourceNoteIds.length) {
                concepts.set(name, { ...c, sourceNoteIds: remaining });
              }
            }
            this.mergeConcepts(concepts, extracted);
            for (const id of batchIds) processed.add(id);
            for (const s of batch) {
              if (hashes[s.note.id] !== undefined) {
                committedHashes[s.note.id] = hashes[s.note.id];
              }
            }
          }
          this.progress({
            phase: "EXTRACT",
            current: i + 1,
            total: batches.length,
            label,
            step: STEP_DONE,
            estimatedTokens: 0,
            largePrompt: false,
          });
        });
        await checkpoint([...concepts.keys()]);
        start = end;
      }
    }

    const notesById = new Map(notes.map((n) => [n.id, n]));
    const pages = new Map((await this.opts.store.loadPages()).map((p) => [p.name, p]));
    const linkableOrder = [...concepts.keys(), OVERVIEW_PAGE].sort((a, b) => {
      const ua = pages.get(a)?.updatedAt ?? 0;
      const ub = pages.get(b)?.updatedAt ?? 0;
      if (ua !== ub) return ub - ua;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const todo = [...concepts.keys()].sort();
    const retryPages = new Set(state.failedPages.slice(0, MAX_FAILED_RETRIES));
    failedPages.push(...state.failedPages.slice(MAX_FAILED_RETRIES));
    const pendingSet = new Set(state.pendingPages);

    const work: PageWork[] = [];
    for (let i = 0; i < todo.length; i++) {
      this.checkAbort();
      const name = todo[i];
      const c = concepts.get(name)!;
      if (c.sourceNoteIds.length === 0) {
        concepts.delete(name);
        if (pages.delete(name)) {
          await this.opts.store.deletePage(name);
          orphans++;
        }
        continue;
      }
      const sourcesChanged = c.sourceNoteIds.some(
        (id) => (state.noteHashes[id] ?? null) !== (hashes[id] ?? null),
      );
      const sourcesMoved =
        setKey(state.concepts[name]?.sourceNoteIds ?? []) !== setKey(c.sourceNoteIds);
      const existing = pages.get(name) ?? null;
      if (
        existing &&
        !sourcesChanged &&
        !sourcesMoved &&
        !retryPages.has(name) &&
        !pendingSet.has(name)
      ) {
        skipped++;
        continue;
      }
      const srcNotes = c.sourceNoteIds
        .map((id) => notesById.get(id))
        .filter((n): n is Note => n !== undefined);
      const oldSources = new Set(state.concepts[name]?.sourceNoteIds ?? []);
      const revisionSources = srcNotes.filter(
        (s) => (state.noteHashes[s.id] ?? null) !== (hashes[s.id] ?? null) || !oldSources.has(s.id),
      );
      const incremental =
        existing !== null &&
        !retryPages.has(name) &&
        !sourcesMoved &&
        revisionSources.length > 0;
      work.push({
        index: i,
        concept: c,
        sources: srcNotes,
        previous: incremental ? existing : null,
        revisionSources: incremental ? revisionSources : [],
      });
    }

    work.sort((a, b) => {
      const ar = retryPages.has(a.concept.name) ? 0 : 1;
      const br = retryPages.has(b.concept.name) ? 0 : 1;
      if (ar !== br) return ar - br;
      const am = a.sources.reduce((m, n) => Math.max(m, n.modified), 0);
      const bm = b.sources.reduce((m, n) => Math.max(m, n.modified), 0);
      if (am !== bm) return bm - am;
      return a.concept.name < b.concept.name ? -1 : 1;
    });

    const runnable =
      this.budget.maxPagesPerRun > 0 ? work.slice(0, this.budget.maxPagesPerRun) : work;
    const pendingRemaining = new Set(work.map((w) => w.concept.name));
    await checkpoint([...pendingRemaining]);

    const hintIds = new Set(runnable.flatMap((w) => w.sources.map((s) => s.id)));
    const relatedByNote = new Map<string, string[]>();
    for (const id of hintIds) {
      const hints = (await this.relatedNotesProvider(id)).filter((h) => h.length > 0);
      if (hints.length > 0) relatedByNote.set(id, hints);
    }

    const concurrency = Math.max(1, this.budget.pageConcurrency);
    for (let start = 0; start < runnable.length; start += concurrency) {
      this.checkAbort();
      const chunk = runnable.slice(start, start + concurrency);
      const results = await Promise.all(
        chunk.map(async (w) => {
          this.checkAbort();
          try {
            const page = await this.generatePage(
              w.concept,
              w.sources,
              w.previous,
              w.revisionSources,
              linkableOrder,
              attachmentsByNote,
              relatedByNote,
              (tokens) =>
                this.progress({
                  phase: "PAGES",
                  current: w.index + 1,
                  total: todo.length + 1,
                  label: w.concept.name,
                  step: STEP_START,
                  estimatedTokens: tokens,
                  largePrompt: tokens >= PromptMetrics.WARN_TOKENS,
                }),
            );
            return { w, page };
          } catch (e) {
            if (isAbort(e)) throw e;
            return { w, page: null };
          }
        }),
      );
      for (const { w, page } of results) {
        if (page === null) {
          uncollected++;
          failedPages.push(w.concept.name);
        } else {
          pages.set(w.concept.name, page);
          await this.opts.store.savePage(page);
          generated++;
        }
        pendingRemaining.delete(w.concept.name);
        this.progress({
          phase: "PAGES",
          current: w.index + 1,
          total: todo.length + 1,
          label: w.concept.name,
          step: STEP_DONE,
          estimatedTokens: 0,
          largePrompt: false,
        });
      }
      await checkpoint([...pendingRemaining]);
    }

    for (const name of [...pages.keys()]) {
      if (name !== OVERVIEW_PAGE && !concepts.has(name)) {
        pages.delete(name);
        await this.opts.store.deletePage(name);
        orphans++;
      }
    }

    if (
      concepts.size > 0 &&
      (generated > 0 || orphans > 0 || !pages.has(OVERVIEW_PAGE))
    ) {
      this.checkAbort();
      const overview = await this.generateOverview([...concepts.values()], (tokens) =>
        this.progress({
          phase: "PAGES",
          current: todo.length + 1,
          total: todo.length + 1,
          label: OVERVIEW_PAGE,
          step: STEP_START,
          estimatedTokens: tokens,
          largePrompt: tokens >= PromptMetrics.WARN_TOKENS,
        }),
      );
      if (overview === null) {
        uncollected++;
      } else {
        pages.set(OVERVIEW_PAGE, overview);
        await this.opts.store.savePage(overview);
        generated++;
      }
      this.progress({
        phase: "PAGES",
        current: todo.length + 1,
        total: todo.length + 1,
        label: OVERVIEW_PAGE,
        step: STEP_DONE,
        estimatedTokens: 0,
        largePrompt: false,
      });
    } else if (concepts.size === 0 && pages.delete(OVERVIEW_PAGE)) {
      await this.opts.store.deletePage(OVERVIEW_PAGE);
      orphans++;
    }

    await checkpoint([...pendingRemaining]);
    return {
      pages: pages.size,
      generated,
      skippedUnchanged: skipped,
      orphansRemoved: orphans,
      uncollected,
      pendingPages: pendingRemaining.size,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedPromptTokens: this.cachedPromptTokens,
      durationMs: this.now() - t0,
    };
  }

  private checkAbort(): void {
    if (this.signal?.aborted) throw abortError();
  }

  private progress(p: Progress): void {
    this.onProgress(p);
  }

  private extractSegments(
    notes: Note[],
    attachmentsByNote: Map<string, Attachment[]>,
  ): ExtractSegment[] {
    const out: ExtractSegment[] = [];
    const maxTotal =
      this.budget.extractSegmentChars * Math.max(1, this.budget.maxSegmentsPerNote);
    for (const n of notes) {
      const full = documentProjectionForAi(
        n,
        attachmentsByNote.get(n.id) ?? [],
        maxTotal,
      );
      const chunks = chunkText(full, this.budget.extractSegmentChars);
      chunks.forEach((chunk, i) => {
        out.push({ note: n, text: chunk, part: i, parts: chunks.length });
      });
    }
    return out;
  }

  private batchSegments(segments: ExtractSegment[], maxChars: number): ExtractSegment[][] {
    const out: ExtractSegment[][] = [];
    let cur: ExtractSegment[] = [];
    let size = 0;
    for (const s of segments) {
      const len = s.text.length + 90;
      if (cur.length > 0 && (size + len > maxChars || cur.length >= MAX_BATCH_NOTES)) {
        out.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(s);
      size += len;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  private segmentLabel(batch: ExtractSegment[]): string {
    const first = batch[0];
    if (!first) return "";
    const name = (
      first.note.title ||
      first.note.body.split(/\r?\n/).find((l) => l.trim().length > 0)?.slice(0, 24)?.trim() ||
      ""
    ).replace(/\n/g, " ");
    const noteCount = new Set(batch.map((s) => s.note.id)).size;
    if (noteCount > 1) return `${name} +${noteCount - 1}`;
    if (first.parts > 1) return `${name} part ${first.part + 1}/${first.parts}`;
    return name;
  }

  private async extractConcepts(
    batch: ExtractSegment[],
    onPrompt: (tokens: number) => void,
  ): Promise<Extracted[] | null> {
    const validIds = new Set(batch.map((s) => s.note.id));
    let user = "Extract the key concepts and entities from these notes.\n\n";
    for (const s of batch) {
      user += `--- note: ${s.note.title.replace(/\n/g, " ")} (part ${s.part + 1}/${s.parts}) ---\n`;
      user += s.text + "\n";
    }
    onPrompt(PromptMetrics.estimateRequest(EXTRACT_SYSTEM, this.withInstruction(user)));
    const raw = await this.chat(
      EXTRACT_SYSTEM,
      user,
      EXTRACT_MAX_OUTPUT_TOKENS,
      this.opts.extractLlm ?? this.opts.llm,
    );
    try {
      const arr = JSON.parse(extractJson(raw)) as unknown;
      if (!Array.isArray(arr)) return null;
      const out: Extracted[] = [];
      for (const el of arr) {
        if (!el || typeof el !== "object") continue;
        const o = el as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        if (!name) continue;
        const kind = o.kind === "entity" ? "entity" : "concept";
        const summary = typeof o.summary === "string" ? o.summary : "";
        const sources = Array.isArray(o.sourceNoteIds)
          ? (o.sourceNoteIds as unknown[])
              .filter((id): id is string => typeof id === "string" && validIds.has(id))
          : [];
        out.push({ name, kind, summary, sourceNoteIds: sources });
      }
      return out;
    } catch {
      return null;
    }
  }

  private mergeConcepts(
    concepts: Map<string, ConceptState>,
    extracted: Extracted[],
  ): void {
    for (const e of extracted) {
      let key = e.name;
      for (const existing of concepts.keys()) {
        if (existing.toLowerCase() === e.name.toLowerCase()) {
          key = existing;
          break;
        }
      }
      const cur = concepts.get(key);
      const sources = [...new Set([...(cur?.sourceNoteIds ?? []), ...e.sourceNoteIds])];
      if (sources.length === 0) continue;
      concepts.set(key, {
        name: key,
        kind: cur?.kind ?? e.kind,
        summary: e.summary || (cur?.summary ?? ""),
        sourceNoteIds: sources,
      });
    }
  }

  private async generatePage(
    c: ConceptState,
    srcNotes: Note[],
    previous: WikiPage | null,
    revisionSources: Note[],
    linkableOrder: string[],
    attachmentsByNote: Map<string, Attachment[]>,
    relatedByNote: Map<string, string[]>,
    onPrompt: (tokens: number) => void,
  ): Promise<WikiPage | null> {
    const sourceTitles = new Set(srcNotes.map((n) => derivedTitle(n.body).toLowerCase()));
    const hints: string[] = [];
    for (const n of srcNotes) {
      for (const hint of relatedByNote.get(n.id) ?? []) {
        if (!hints.includes(hint) && !sourceTitles.has(hint.toLowerCase())) {
          hints.push(hint);
        }
      }
    }
    const cappedHints = hints.slice(0, this.budget.relatedHints);

    const quoted = [...srcNotes]
      .sort((a, b) => (b.modified - a.modified) || (a.id < b.id ? -1 : 1))
      .slice(0, this.budget.pageSourceNotes);
    const revision = previous !== null && revisionSources.length > 0;
    const promptNotes = revision ? revisionSources : quoted;
    const perNote =
      promptNotes.length === 0
        ? this.budget.noteChars
        : Math.max(
            MIN_PAGE_NOTE_CHARS,
            Math.min(
              Math.floor(this.budget.pageSourceChars / promptNotes.length),
              Math.max(this.budget.noteChars, MIN_PAGE_NOTE_CHARS),
            ),
          );

    let user = PAGE_RULES;
    user += `Linkable pages: ${this.stableCatalog(linkableOrder)}\n`;
    user += `Name: ${c.name}\n`;
    user += `Kind: ${c.kind}\n`;
    user += `Summary: ${c.summary.slice(0, MAX_SUMMARY_CHARS)}\n`;
    if (cappedHints.length > 0) {
      user +=
        "Related notes (semantic similarity; draw on their ideas and link where relevant): " +
        cappedHints.join(", ") +
        "\n";
    }
    if (revision) {
      user +=
        "\nREVISION MODE: update the existing page using the changed/new sources below; " +
        "preserve its structure and links.\nPREVIOUS PAGE:\n" +
        (previous?.body.split("\n\n---\n\n## ")[0] ?? "").slice(0, this.budget.pageSourceChars) +
        "\n";
      user += "\nCHANGED/NEW SOURCE NOTES\n";
    } else {
      user += "\nSOURCE NOTES\n";
    }
    for (const n of promptNotes) {
      user += `--- note: ${n.title.replace(/\n/g, " ")} ---\n`;
      user +=
        documentProjectionForAi(n, attachmentsByNote.get(n.id) ?? [], perNote) + "\n";
    }
    if (revision) {
      user += "\n(Unchanged sources are already reflected in the previous page.)\n";
    } else if (quoted.length < srcNotes.length) {
      user +=
        `\n(${srcNotes.length - quoted.length} older source notes are omitted here for space; ` +
        "still cover their shared theme in the page.)\n";
    }

    onPrompt(PromptMetrics.estimateRequest(PAGE_SYSTEM, this.withInstruction(user)));
    const raw = await this.chat(PAGE_SYSTEM, user, PAGE_MAX_OUTPUT_TOKENS);
    let parsed: { title: string; body: string } | null = null;
    try {
      const o = JSON.parse(extractJson(raw)) as Record<string, unknown>;
      const title =
        typeof o.title === "string" && o.title.trim() ? o.title.trim() : c.name;
      const body = typeof o.body === "string" ? o.body.trim() : "";
      if (body) parsed = { title, body };
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.body.length < MIN_PAGE_BODY_CHARS) return null;
    return {
      name: c.name,
      title: parsed.title,
      kind: c.kind,
      body: parsed.body + this.provenanceFooter(srcNotes),
      sourceNoteIds: srcNotes.map((n) => n.id),
      updatedAt: this.now(),
    };
  }

  private async generateOverview(
    concepts: ConceptState[],
    onPrompt: (tokens: number) => void,
  ): Promise<WikiPage | null> {
    let user = "Write the overview index page for a personal wiki with these pages.\n";
    let omitted = 0;
    for (const c of [...concepts].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const line = `- ${c.name} (${c.kind}): ${c.summary.slice(0, MAX_SUMMARY_CHARS)}\n`;
      if (user.length + line.length > this.budget.overviewChars) {
        omitted++;
        continue;
      }
      user += line;
    }
    if (omitted > 0) {
      user +=
        `(${omitted} more pages omitted for space; link the ones listed, ` +
        "and do not invent the missing names.)\n";
    }
    onPrompt(PromptMetrics.estimateRequest(OVERVIEW_SYSTEM, this.withInstruction(user)));
    const raw = await this.chat(OVERVIEW_SYSTEM, user, OVERVIEW_MAX_OUTPUT_TOKENS);
    try {
      const o = JSON.parse(extractJson(raw)) as Record<string, unknown>;
      const title =
        typeof o.title === "string" && o.title.trim() ? o.title.trim() : "Overview";
      const body = typeof o.body === "string" ? o.body.trim() : "";
      if (!body) return null;
      return {
        name: OVERVIEW_PAGE,
        title,
        kind: "overview",
        body,
        sourceNoteIds: [],
        updatedAt: this.now(),
      };
    } catch {
      return null;
    }
  }

  private stableCatalog(ordered: string[]): string {
    let out = "";
    let truncated = false;
    for (const name of ordered) {
      const sep = out.length === 0 ? 0 : 2;
      if (out.length + sep + name.length > this.budget.linkableChars) {
        truncated = true;
        break;
      }
      if (out.length > 0) out += ", ";
      out += name;
    }
    if (truncated) out += " …";
    return out || "(none)";
  }

  private async chat(
    system: string,
    user: string,
    maxOutputTokens: number | null = null,
    client: LlmClient = this.opts.llm,
  ): Promise<string> {
    const [content, usage] = await client.chatWithUsage(
      this.bounded(system, this.budget.hardSystemChars),
      this.bounded(this.withInstruction(user), this.budget.hardUserChars),
      maxOutputTokens ?? undefined,
    );
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.cachedPromptTokens += usage.cachedPromptTokens;
    return content;
  }

  private withInstruction(user: string): string {
    const extra = this.userInstruction.trim();
    return extra ? user + "\n\nAdditional instructions from the user:\n" + extra : user;
  }

  private bounded(text: string, maxChars: number): string {
    return text.length <= maxChars
      ? text
      : text.slice(0, maxChars) + "\n[... prompt truncated to stay within budget ...]";
  }

  private provenanceFooter(srcNotes: Note[]): string {
    let out = `\n\n---\n\n## ${this.sourcesHeading}\n`;
    for (const n of srcNotes) {
      out += `- \`${n.id}\` ${(n.title || "(untitled)").replace(/\n/g, " ")}\n`;
    }
    return out;
  }
}

/** Splits text into line-aligned chunks no larger than maxChars. */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl > start) end = nl;
    }
    if (end <= start) end = Math.min(start + maxChars, text.length);
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Groups notes into ≤ maxChars batches, at most MAX_BATCH_NOTES each. */
export function batchNotes(
  notes: Note[],
  maxChars: number,
  sizeOf: (n: Note) => number = (n) => n.title.length + n.body.length + 50,
): Note[][] {
  const out: Note[][] = [];
  let cur: Note[] = [];
  let size = 0;
  for (const n of notes) {
    const len = sizeOf(n);
    if (cur.length > 0 && (size + len > maxChars || cur.length >= MAX_BATCH_NOTES)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(n);
    size += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Candidate pages that would compile differently than their stored state. */
export async function stalePages(
  pages: WikiPage[],
  state: WikiState,
  notes: Note[],
  attachments: Attachment[] = [],
): Promise<Set<string>> {
  const byNote = groupByNote(attachments);
  const current: Record<string, string> = {};
  for (const n of notes) {
    current[n.id] = await contentHash(n, byNote.get(n.id) ?? []);
  }
  const out = new Set<string>();
  for (const page of pages) {
    if (page.sourceNoteIds.some((id) => current[id] !== state.noteHashes[id])) {
      out.add(page.name);
    }
  }
  return out;
}

/** In-memory store used by tests and as the web-dev fallback. */
export class MemoryWikiStore implements WikiStore {
  pages = new Map<string, WikiPage>();
  state: WikiState = emptyWikiState();

  async loadPages(): Promise<WikiPage[]> {
    return [...this.pages.values()];
  }
  async savePage(page: WikiPage): Promise<void> {
    this.pages.set(page.name, page);
  }
  async deletePage(name: string): Promise<void> {
    this.pages.delete(name);
  }
  async loadState(): Promise<WikiState> {
    return structuredClone(this.state);
  }
  async saveState(state: WikiState): Promise<void> {
    this.state = structuredClone(state);
  }
}

function groupByNote(list: Attachment[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  for (const a of list) {
    const arr = out.get(a.noteId) ?? [];
    arr.push(a);
    out.set(a.noteId, arr);
  }
  return out;
}

function setKey(ids: string[]): string {
  return [...ids].sort().join("\u0000");
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
