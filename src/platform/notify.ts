import { hasTauri } from "./tauri.ts";

/**
 * OS notification via tauri-plugin-notification. Silent no-op outside Tauri
 * or when the permission is declined (Android's DueReminderWorker degrades
 * the same way).
 */
export async function sendNotification(title: string, body: string): Promise<void> {
  if (!hasTauri()) return;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) granted = (await mod.requestPermission()) === "granted";
    if (granted) mod.sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}
