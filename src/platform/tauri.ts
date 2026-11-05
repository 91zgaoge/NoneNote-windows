/** Tauri host bridge. All file/HTTP access goes through the Rust commands. */

export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let cachedInvoke: InvokeFn | null = null;

export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!cachedInvoke) {
    const mod = (await import("@tauri-apps/api/core")) as { invoke: InvokeFn };
    cachedInvoke = mod.invoke;
  }
  return cachedInvoke<T>(cmd, args);
}
