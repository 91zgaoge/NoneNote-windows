import { useMemo, useState } from "react";

type Tab = "notes" | "archive" | "settings";

const SAMPLE = [
  { id: "1", title: "Grocery", preview: "Oat milk, citrus, coriander", dash: "#E0AD08", ago: "2m" },
  { id: "2", title: "Japan trip", preview: "Shinjuku hotel · Suica", dash: "#2280D6", ago: "1h" },
  { id: "3", title: "Ideas", preview: "Paper desk across three platforms", dash: "#0E9B6E", ago: "Yesterday" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("notes");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(SAMPLE[0].id);

  const notes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SAMPLE;
    return SAMPLE.filter(
      (n) => n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q),
    );
  }, [query]);

  const active = SAMPLE.find((n) => n.id === selected) ?? notes[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">NoneNote</div>
        <div className="segmented" role="tablist">
          {(
            [
              ["notes", "Notes"],
              ["archive", "Archive"],
              ["settings", "Settings"],
            ] as const
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
        {tab !== "settings" && (
          <input
            className="search"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {tab === "settings" ? (
          <div className="settings-group">
            <h3>Sync</h3>
            <p style={{ margin: 0, color: "var(--ink-secondary)", fontSize: 13 }}>
              WebDAV shell — wire the same sync.json protocol as Android/macOS.
            </p>
          </div>
        ) : notes.length === 0 ? (
          <div className="empty">
            <h2>Your desk is clear</h2>
            <p>Create a note from the edge deck when it lands.</p>
          </div>
        ) : (
          <ul className="note-list">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="note-row"
                  style={{ width: "100%", textAlign: "left", border: 0, background: "transparent" }}
                  onClick={() => setSelected(n.id)}
                >
                  <span className="dash" style={{ ["--dash" as string]: n.dash }} />
                  <span>
                    <div className="title">{n.title}</div>
                    <div className="meta">
                      {n.ago} · {n.preview}
                    </div>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="main">
        {tab === "settings" ? (
          <div className="settings-group">
            <h3>Paper Desk</h3>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              Windows shell uses the same tokens as Android and macOS. Edge overlay
              and WebDAV come next; this screen is the visual scaffold only.
            </p>
          </div>
        ) : active ? (
          <article className="paper" style={{ borderLeftColor: active.dash }}>
            <h1>{active.title}</h1>
            <p>{active.preview}</p>
          </article>
        ) : (
          <div className="empty">
            <h2>Select a note</h2>
          </div>
        )}
      </main>
    </div>
  );
}
