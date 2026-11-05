import { storage } from "./platform/storage.ts";
import { hasTauri, tauriInvoke } from "./platform/tauri.ts";
import { NOTE_COLORS } from "./core/palette.ts";
import type { Note } from "./core/types.ts";

const root = document.getElementById("edge")!;
const MAX_DASHES = 7;
const FALLBACK = ["#E0AD08", "#2280D6", "#0E9B6E", "#B54A3C"];

/**
 * Edge deck: one dash per pinned/recent note, ordered like the library.
 * Clicking a dash brings the main window forward and opens that note.
 */
async function render(): Promise<void> {
  let notes: Note[] = [];
  try {
    notes = (await storage.load<Note[]>("notes")) ?? [];
  } catch {
    notes = [];
  }
  const active = notes
    .filter((n) => !n.archived)
    .sort((a, b) => a.order - b.order || b.modified - a.modified)
    .slice(0, MAX_DASHES);

  root.replaceChildren();
  const pill = document.createElement("div");
  pill.className = "edge-pill";
  pill.setAttribute("aria-label", "NoneNote note deck");

  if (active.length === 0) {
    for (const color of FALLBACK) {
      const dash = document.createElement("span");
      dash.className = "edge-dash";
      dash.style.background = color;
      pill.append(dash);
    }
  } else {
    for (const note of active) {
      const dash = document.createElement("button");
      dash.type = "button";
      dash.className = "edge-dash";
      dash.style.background = NOTE_COLORS[note.color % NOTE_COLORS.length];
      dash.title = note.title || "New note";
      dash.addEventListener("click", () => {
        if (hasTauri()) void tauriInvoke("open_note", { id: note.id });
      });
      pill.append(dash);
    }
  }
  root.append(pill);
}

void render();

if (hasTauri()) {
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("state-saved", (event) => {
      if (event.payload === "notes") void render();
    });
  })();
}
