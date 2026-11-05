import { storage } from "./platform/storage.ts";
import { hasTauri, tauriInvoke } from "./platform/tauri.ts";
import { NOTE_COLORS } from "./core/palette.ts";
import type { Note } from "./core/types.ts";

const root = document.getElementById("edge")!;
const MAX_DASHES = 7;
const FALLBACK = ["#E0AD08", "#2280D6", "#0E9B6E", "#B54A3C"];

let expanded = false;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;

function setExpanded(next: boolean): void {
  if (expanded === next) return;
  expanded = next;
  root.classList.toggle("expanded", expanded);
  if (hasTauri()) {
    void tauriInvoke("edge_set_expanded", { expanded }).catch(() => undefined);
  }
}

function preview(note: Note): string {
  const lines = note.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rest = lines.slice(1).join(" ");
  const text = rest || lines[0] || "";
  return text.length > 90 ? text.slice(0, 90) + "…" : text;
}

/**
 * Edge deck: one dash per recent note in the collapsed 44px rail, and a card
 * panel that slides in when the window expands on hover. Clicking a dash or
 * card brings the main window forward and opens that note.
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
  const deck = document.createElement("div");
  deck.className = "edge-deck";

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
        setExpanded(false);
      });
      pill.append(dash);
    }
  }

  const cards = document.createElement("div");
  cards.className = "edge-cards";
  const heading = document.createElement("div");
  heading.className = "edge-heading";
  heading.textContent = active.length > 0 ? `NoneNote · ${active.length}` : "NoneNote";
  cards.append(heading);

  if (active.length === 0) {
    const empty = document.createElement("div");
    empty.className = "edge-empty";
    empty.textContent = "No notes yet · 暂无便签";
    cards.append(empty);
  } else {
    for (const note of active) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "edge-card";
      card.style.setProperty("--dash", NOTE_COLORS[note.color % NOTE_COLORS.length]);
      const title = document.createElement("div");
      title.className = "edge-card-title";
      title.textContent = note.title || "New note";
      const meta = document.createElement("div");
      meta.className = "edge-card-meta";
      meta.textContent = preview(note) || new Date(note.modified).toLocaleString();
      card.append(title, meta);
      card.addEventListener("click", () => {
        if (hasTauri()) void tauriInvoke("open_note", { id: note.id });
        setExpanded(false);
      });
      cards.append(card);
    }
  }

  deck.append(cards, pill);
  root.replaceChildren(deck);
}

root.addEventListener("mouseenter", () => {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = null;
  setExpanded(true);
});
root.addEventListener("mouseleave", () => {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => setExpanded(false), 260);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setExpanded(false);
});

function renderFallback(): void {
  if (root.childElementCount > 0) return;
  const deck = document.createElement("div");
  deck.className = "edge-deck";
  const pill = document.createElement("div");
  pill.className = "edge-pill";
  pill.setAttribute("aria-label", "NoneNote note deck");
  for (const color of FALLBACK) {
    const dash = document.createElement("span");
    dash.className = "edge-dash";
    dash.style.background = color;
    pill.append(dash);
  }
  deck.append(pill);
  root.append(deck);
}

renderFallback();
void render();

if (hasTauri()) {
  void tauriInvoke("edge_place").catch(() => undefined);
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("state-saved", (event) => {
      if (event.payload === "notes") void render();
    });
  })();
}
