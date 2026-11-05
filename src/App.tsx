import { useEffect, useReducer, useRef, useState } from "react";
import { getAppModel, type AppModel } from "./appModel.ts";
import { NoteEditor } from "./ui/NoteEditor.tsx";
import { NOTE_COLORS } from "./core/palette.ts";
import { hasTauri } from "./platform/tauri.ts";
import { WikiPanel } from "./ui/WikiPanel.tsx";
import { SettingsPanel } from "./ui/SettingsPanel.tsx";
import { notePreview } from "./core/text.ts";
import type { Note } from "./core/types.ts";
import { t, type Lang } from "./i18n.ts";

type Tab = "notes" | "archive" | "wiki" | "settings";

export function App() {
  const [model, setModel] = useState<AppModel | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [tab, setTab] = useState<Tab>(() => {
    const hash = typeof location === "undefined" ? "" : location.hash.replace("#", "");
    return hash === "archive" || hash === "wiki" || hash === "settings" ? hash : "notes";
  });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void getAppModel().then((m) => {
      m.noteStore.subscribe(() => force());
      m.settingsStore.subscribe(() => force());
      m.subscribeRemoteApplied(() => {
        setRevision((x) => x + 1);
        force();
      });
      setModel(m);
    });
  }, []);

  useEffect(() => {
    if (!model || !hasTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen<string>("open-note", (event) => {
        setTab("notes");
        setSelectedId(event.payload);
      });
    });
    return () => unlisten?.();
  }, [model]);

  if (!model) {
    return <div className="empty">Loading…</div>;
  }

  const settings = model.settingsStore.get();
  const lang: Lang = settings.language;
  const pending = model.noteStore.pendingDelete();

  const list = tab === "archive" ? model.noteStore.archived() : model.noteStore.active();
  const q = query.trim().toLowerCase();
  const visible = q
    ? list.filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(q))
    : list;
  const selected = visible.find((n) => n.id === selectedId) ?? visible[0] ?? null;

  const sync = model.sync.lastSyncResult;
  const syncText = !settings.webdavUrl.trim()
    ? t(lang, "sync.not_configured")
    : sync === null
      ? t(lang, "sync.never")
      : sync.kind === "ok"
        ? t(lang, "sync.ok", { n: sync.noteCount })
        : sync.kind === "failed"
          ? t(lang, "sync.failed", { detail: sync.detail })
          : t(lang, "sync.not_configured");

  function createNote() {
    const n = model!.noteStore.create();
    setTab("notes");
    setSelectedId(n.id);
  }

  function renderNoteRow(n: Note) {
    return (
      <li key={n.id}>
        <button
          type="button"
          className={`note-row${n.id === selected?.id ? " active" : ""}`}
          onClick={() => setSelectedId(n.id)}
        >
          <span
            className="dash"
            style={{ ["--dash" as string]: NOTE_COLORS[n.color % NOTE_COLORS.length] }}
          />
          <span>
            <div className="title">
              {n.pinned ? "📌 " : ""}
              {n.title || t(lang, "editor.title")}
            </div>
            <div className="meta">
              {new Date(n.modified).toLocaleString()} · {notePreview(n)}
            </div>
          </span>
        </button>
      </li>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="" width={28} height={28} />
          {t(lang, "app.brand")}
        </div>
        <div className="segmented" role="tablist">
          {(
            [
              ["notes", t(lang, "tabs.notes")],
              ["archive", t(lang, "tabs.archive")],
              ["wiki", t(lang, "tabs.wiki")],
              ["settings", t(lang, "tabs.settings")],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {(tab === "notes" || tab === "archive") && (
          <>
            <input
              className="search"
              placeholder={t(lang, "search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {tab === "notes" && (
              <button type="button" className="button primary" onClick={createNote}>
                + {t(lang, "notes.new")}
              </button>
            )}
            {visible.length === 0 ? (
              <div className="empty">
                <h2>{q ? t(lang, "search.placeholder") : t(lang, "notes.empty.title")}</h2>
                {!q && <p>{t(lang, "notes.empty.body")}</p>}
              </div>
            ) : (
              <ul className="note-list">{visible.map(renderNoteRow)}</ul>
            )}
          </>
        )}

        <div className="sync-footer">
          <span className="muted">{syncText}</span>
          <button type="button" className="chip" onClick={() => void model.sync.sync("manual")}>
            {t(lang, "sync.now")}
          </button>
        </div>
      </aside>

      <main className="main">
        {tab === "wiki" ? (
          <WikiPanel model={model} lang={lang} revision={revision} />
        ) : tab === "settings" ? (
          <SettingsPanel model={model} lang={lang} />
        ) : selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            lang={lang}
            onBody={(id, body) => model.noteStore.updateBody(id, body)}
            onTitle={(id, title) => model.noteStore.setTitle(id, title)}
            onPin={(id) => model.noteStore.togglePin(id)}
            onArchive={(id, archived) => {
              model.noteStore.setArchived(id, archived);
              setSelectedId(null);
            }}
            onDelete={(id) => {
              model.noteStore.delete(id);
              setSelectedId(null);
            }}
            onColor={(id, color) => model.noteStore.setColor(id, color)}
            onMove={(id, by) => model.noteStore.reorder(id, by)}
          />
        ) : (
          <div className="empty">
            <h2>{t(lang, "editor.select")}</h2>
          </div>
        )}
      </main>

      {pending && (
        <div className="toast">
          <span>{t(lang, "notes.deleted")}</span>
          <button
            type="button"
            className="chip"
            onClick={() => {
              model.noteStore.undoDelete();
              setSelectedId(pending.note.id);
            }}
          >
            {t(lang, "notes.undo")}
          </button>
        </div>
      )}
    </div>
  );
}
