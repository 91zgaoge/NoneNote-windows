import type { WikiPage, WikiState } from "../core/types.ts";
import { emptyWikiState } from "../core/types.ts";
import type { WikiStore } from "../core/wiki/compiler.ts";
import type { StorageAdapter } from "../platform/storage.ts";
import { sha256Sync } from "../core/wiki/text.ts";

const INDEX_KEY = "wiki.index";
const STATE_KEY = "wiki.state";
const PAGE_PREFIX = "wiki.page.";

/** Page storage keyed by name; one write per page, not a whole-corpus rewrite. */
export class FileWikiStore implements WikiStore {
  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async loadPages(): Promise<WikiPage[]> {
    const index = (await this.storage.load<string[]>(INDEX_KEY)) ?? [];
    const pages = await Promise.all(
      index.map((name) => this.storage.load<WikiPage>(pageKey(name))),
    );
    return pages.filter((p): p is WikiPage => !!p && typeof p.name === "string");
  }

  async savePage(page: WikiPage): Promise<void> {
    await this.storage.save(pageKey(page.name), page);
    const index = (await this.storage.load<string[]>(INDEX_KEY)) ?? [];
    if (!index.includes(page.name)) {
      await this.storage.save(INDEX_KEY, [...index, page.name]);
    }
  }

  async deletePage(name: string): Promise<void> {
    await this.storage.remove(pageKey(name));
    const index = (await this.storage.load<string[]>(INDEX_KEY)) ?? [];
    if (index.includes(name)) {
      await this.storage.save(
        INDEX_KEY,
        index.filter((n) => n !== name),
      );
    }
  }

  async loadState(): Promise<WikiState> {
    const state = await this.storage.load<WikiState>(STATE_KEY);
    return state ? { ...emptyWikiState(), ...state } : emptyWikiState();
  }

  async saveState(state: WikiState): Promise<void> {
    await this.storage.save(STATE_KEY, state);
  }
}

function pageKey(name: string): string {
  // Hashed keys keep the Tauri key whitelist and the 200-char path bound safe
  // for arbitrary CJK/long page names; the name itself lives in the page JSON.
  return PAGE_PREFIX + sha256Sync(name).slice(0, 32);
}
