import type { AppSettings } from "../core/types.ts";
import { emptySettings } from "../core/types.ts";
import type { StorageAdapter } from "../platform/storage.ts";

const KEY = "settings";

/** Settings with defaults filled in and serialized writes. */
export class SettingsStore {
  private value: AppSettings = emptySettings();
  private loaded = false;
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();

  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.get();
    const stored = await this.storage.load<Partial<AppSettings>>(KEY);
    this.value = normalize({ ...emptySettings(), ...(stored ?? {}) });
    this.loaded = true;
    return this.get();
  }

  get(): AppSettings {
    return { ...this.value, profiles: this.value.profiles.map((p) => ({ ...p })) };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    this.value = normalize({ ...this.value, ...patch });
    this.emit();
    await this.persist();
  }

  /** Persist without emitting again (used by sync bookkeeping). */
  async persist(): Promise<void> {
    const snapshot = this.get();
    const next = this.chain.then(() => this.storage.save(KEY, snapshot));
    this.chain = next.catch(() => undefined);
    await next;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function normalize(s: AppSettings): AppSettings {
  const profiles = Array.isArray(s.profiles) && s.profiles.length > 0 ? s.profiles : emptySettings().profiles;
  const active =
    profiles.find((p) => p.id === s.activeProfileId)?.id ?? profiles[0].id;
  return {
    ...s,
    profiles: profiles.map((p) => ({
      ...p,
      temperature: Number.isFinite(p.temperature) ? p.temperature : 0.7,
      maxTokens: Number.isFinite(p.maxTokens) ? p.maxTokens : 2048,
    })),
    activeProfileId: active,
    wikiExtractProfileId: profiles.some((p) => p.id === s.wikiExtractProfileId)
      ? s.wikiExtractProfileId
      : "",
    wikiMaxPagesPerRun: Math.max(0, Math.floor(s.wikiMaxPagesPerRun || 0)),
    wikiAutoCompileMinutes: Math.min(1439, Math.max(0, Math.floor(s.wikiAutoCompileMinutes || 0))),
  };
}
