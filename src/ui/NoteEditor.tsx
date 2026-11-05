import { useEffect, useRef, useState } from "react";
import type { Note } from "../core/types.ts";
import type { LocalAttachment } from "../core/attachment/store.ts";
import { t, type Lang } from "../i18n.ts";
import { NOTE_COLORS, NOTE_INKS, NOTE_PAPERS } from "../core/palette.ts";

interface Props {
  note: Note;
  lang: Lang;
  attachments: LocalAttachment[];
  previews: Record<string, string>;
  onAttach: (file: File) => void;
  onDownloadAttachment: (a: LocalAttachment) => void;
  onRemoveAttachment: (a: LocalAttachment) => void;
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
  const fileRef = useRef<HTMLInputElement | null>(null);

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
    <article
      className="paper"
      style={{
        borderLeftColor: NOTE_COLORS[note.color % NOTE_COLORS.length],
        background: NOTE_PAPERS[note.color % NOTE_PAPERS.length],
        color: NOTE_INKS[note.color % NOTE_INKS.length],
      }}
    >
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
      <div className="attachments">
        <div className="row">
          <button type="button" className="chip" onClick={() => fileRef.current?.click()}>
            + {t(lang, "editor.attach")}
          </button>
          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onAttach(file);
              e.target.value = "";
            }}
          />
        </div>
        {props.attachments.map((a) => (
          <div className="attachment" key={a.id}>
            {props.previews[a.id] && (
              <img className="attachment-thumb" src={props.previews[a.id]} alt={a.fileName} />
            )}
            <div className="attachment-meta">
              <div className="attachment-name">{a.fileName}</div>
              <div className="muted">
                {formatSize(a.size)}
                {!a.hasPayload ? " · remote" : ""}
              </div>
            </div>
            <button
              type="button"
              className="chip"
              disabled={!a.hasPayload}
              onClick={() => props.onDownloadAttachment(a)}
            >
              {t(lang, "editor.attachment.download")}
            </button>
            <button
              type="button"
              className="chip danger"
              onClick={() => props.onRemoveAttachment(a)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}
