import { hasTauri, tauriInvoke } from "./tauri.ts";

/** Key/value persistence seam; keys are flat names like "notes" / "settings". */
export interface StorageAdapter {
  load<T>(key: string): Promise<T | null>;
  save(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

class TauriStorage implements StorageAdapter {
  async load<T>(key: string): Promise<T | null> {
    const raw = await tauriInvoke<string | null>("state_load", { key });
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async save(key: string, value: unknown): Promise<void> {
    await tauriInvoke("state_save", { key, json: JSON.stringify(value) });
  }

  async remove(key: string): Promise<void> {
    await tauriInvoke("state_delete", { key });
  }
}

class WebStorage implements StorageAdapter {
  async load<T>(key: string): Promise<T | null> {
    const raw = localStorage.getItem(`nonenote.${key}`);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async save(key: string, value: unknown): Promise<void> {
    localStorage.setItem(`nonenote.${key}`, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(`nonenote.${key}`);
  }
}

export const storage: StorageAdapter = hasTauri()
  ? new TauriStorage()
  : new WebStorage();
