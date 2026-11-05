import { useEffect, useRef, useState } from "react";
import type { Note } from "../core/types.ts";
import { t, type Lang } from "../i18n.ts";
import { NOTE_COLORS } from "../core/palette.ts";

interface Props {
  note: Note;
  lang: Lang;
  onBody: (id: string, body: string) => void;
  onTitle: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onColor: (id: string, color: number) => void;
  onMove: (id: string, by: number) => void;
}

export function NoteEditor(props: Props) {
  const { note, lang } = props;
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const titleDirty = useRef(false);
  const bodyDirty = useRef(false);

  // Commit edits after a short pause; every keystroke must not rewrite the
  // whole notes file.
  useEffect(() => {
    if (!titleDirty.current && !bodyDirty.current) return;
    const timer = setTimeout(() => {
      if (titleDirty.current && title !== note.title) props.onTitle(note.id, title);
      if (bodyDirty.current && body !== note.body) props.onBody(note.id, body);
      titleDirty.current = false;
      bodyDirty.current = false;
    }, 400);
    return () => clearTimeout(timer);
  }, [title, body, note.id, note.title, note.body]);

  return (
    <article className="paper" style={{ borderLeftColor: NOTE_COLORS[note.color % NOTE_COLORS.length] }}>
      <div className="paper-toolbar">
        <button type="button" className="chip" onClick={() => props.onPin(note.id)}>
          {note.pinned ? t(lang, "editor.unpin") : t(lang, "editor.pin")}
        </button>
        <button type="button" className="chip" onClick={() => props.onMove(note.id, -1)}>
          ↑
        </button>
        <button type="button" className="chip" onClick={() => props.onMove(note.id, 1)}>
          ↓
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="chip"
          onClick={() => props.onArchive(note.id, !note.archived)}
        >
          {note.archived ? t(lang, "editor.unarchive") : t(lang, "editor.archive")}
        </button>
        <button type="button" className="chip danger" onClick={() => props.onDelete(note.id)}>
          {t(lang, "editor.delete")}
        </button>
      </div>
      <input
        className="paper-title"
        value={title}
        placeholder={t(lang, "editor.title")}
        onChange={(e) => {
          titleDirty.current = true;
          setTitle(e.target.value);
        }}
      />
      <textarea
        className="paper-body"
        value={body}
        placeholder={t(lang, "editor.body")}
        onChange={(e) => {
          bodyDirty.current = true;
          setBody(e.target.value);
        }}
      />
      <div className="palette">
        {NOTE_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={`color ${i}`}
            className={`swatch${note.color === i ? " active" : ""}`}
            style={{ background: c }}
            onClick={() => props.onColor(note.id, i)}
          />
        ))}
      </div>
    </article>
  );
}
