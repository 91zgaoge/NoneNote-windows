import type { AiProfile, AppSettings, Note, WikiPage } from "../types.ts";
import { activeProfile, extractProfile } from "../types.ts";
import type { HttpTransport } from "../http.ts";
import { AiClient } from "../ai/client.ts";
import type { LlmClient } from "../ai/client.ts";
import type { WikiStore, Progress, Summary } from "./compiler.ts";
import { WikiCompiler } from "./compiler.ts";

/** Background runs must not hog the endpoint; manual runs stay unlimited. */
export const BACKGROUND_MAX_PAGES_PER_RUN = 60;

export class WikiNotConfiguredError extends Error {
  constructor() {
    super("wiki AI is not configured");
    this.name = "WikiNotConfiguredError";
  }
}

export class WikiAlreadyRunningError extends Error {
  constructor() {
    super("wiki compile is already running");
    this.name = "WikiAlreadyRunningError";
  }
}

export interface WikiCompileDeps {
  notes: () => Note[];
  wikiStore: WikiStore;
  settings: () => AppSettings;
  transport: HttpTransport;
  clientFactory?: (profile: AiProfile) => LlmClient;
}

export interface CompileOptions {
  background?: boolean;
  signal?: AbortSignal;
}

/**
 * Shared owner of the wiki compiler. Manual (wiki tab) and scheduled runs go
 * through this service so they can never write the wiki concurrently, and the
 * UI can observe background progress.
 */
export class WikiCompileService {
  private readonly deps: WikiCompileDeps;
  private current: Promise<Summary> | null = null;
  private controller: AbortController | null = null;
  private readonly progressListeners = new Set<(p: Progress) => void>();
  private readonly summaryListeners = new Set<(s: Summary) => void>();
  private readonly stateListeners = new Set<(running: boolean) => void>();
  private readonly errorListeners = new Set<(e: Error) => void>();

  lastSummary: Summary | null = null;

  constructor(deps: WikiCompileDeps) {
    this.deps = deps;
  }

  running(): boolean {
    return this.current !== null;
  }

  subscribeProgress(fn: (p: Progress) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  subscribeSummary(fn: (s: Summary) => void): () => void {
    this.summaryListeners.add(fn);
    return () => this.summaryListeners.delete(fn);
  }

  subscribeState(fn: (running: boolean) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  subscribeError(fn: (e: Error) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  cancel(): void {
    this.controller?.abort();
  }

  async compile(opts: CompileOptions = {}): Promise<Summary> {
    if (this.current) throw new WikiAlreadyRunningError();
    const settings = this.deps.settings();
    const profile = activeProfile(settings);
    if (!profile.baseUrl.trim() || !profile.model.trim()) {
      throw new WikiNotConfiguredError();
    }
    const extract = extractProfile(settings);
    const factory =
      this.deps.clientFactory ??
      ((p: AiProfile) =>
        new AiClient(
          p.baseUrl,
          p.apiKey,
          p.model,
          p.temperature,
          p.maxTokens,
          this.deps.transport,
        ));
    const llm = factory(profile);
    const extractLlm = extract.id === profile.id ? llm : factory(extract);

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.controller = controller;
    const compiler = new WikiCompiler({
      notesProvider: this.deps.notes,
      llm,
      extractLlm,
      store: this.deps.wikiStore,
      budget: {
        maxPagesPerRun: opts.background
          ? BACKGROUND_MAX_PAGES_PER_RUN
          : settings.wikiMaxPagesPerRun,
      },
      signal: controller.signal,
      onProgress: (p) => {
        for (const fn of this.progressListeners) fn(p);
      },
    });

    this.emitState(true);
    const run = compiler.compile();
    this.current = run;
    try {
      const summary = await run;
      this.lastSummary = summary;
      for (const fn of this.summaryListeners) fn(summary);
      return summary;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      for (const fn of this.errorListeners) fn(error);
      throw error;
    } finally {
      this.current = null;
      this.controller = null;
      this.emitState(false);
    }
  }

  private emitState(running: boolean): void {
    for (const fn of this.stateListeners) fn(running);
  }
}

/** Local calendar day key, YYYY-MM-DD (not UTC). */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Daily scheduled compile, mirroring Android's "Scheduled wiki compile":
 * off by default, one run per local day at the configured wall-clock time.
 * Windows has no WorkManager, so this only runs while the app is open.
 */
export function autoCompileDue(settings: AppSettings, now: number): boolean {
  if (!settings.wikiAutoCompile) return false;
  const profile = activeProfile(settings);
  if (!profile.baseUrl.trim() || !profile.model.trim()) return false;
  if (settings.wikiAutoCompileLastDay === localDayKey(now)) return false;
  const due = new Date(now);
  const minutes = Math.min(1439, Math.max(0, settings.wikiAutoCompileMinutes));
  due.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return now >= due.getTime();
}

export interface SchedulerService {
  running(): boolean;
  compile(opts: { background?: boolean }): Promise<Summary>;
}

export interface SchedulerSettings {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): Promise<void>;
  subscribe?(fn: () => void): () => void;
}

export class WikiScheduler {
  private readonly service: SchedulerService;
  private readonly settings: SchedulerSettings;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private ticking = false;

  onError: ((e: Error) => void) | null = null;

  constructor(
    service: SchedulerService,
    settings: SchedulerSettings,
    now: () => number = () => Date.now(),
  ) {
    this.service = service;
    this.settings = settings;
    this.now = now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.unsubscribe = this.settings.subscribe?.(() => void this.tick()) ?? null;
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.settings.get();
      const now = this.now();
      if (!autoCompileDue(settings, now) || this.service.running()) return;
      // Mark the day before running so a crash/failure cannot loop every minute.
      await this.settings.update({ wikiAutoCompileLastDay: localDayKey(now) });
      try {
        await this.service.compile({ background: true });
      } catch (e) {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      this.ticking = false;
    }
  }
}
