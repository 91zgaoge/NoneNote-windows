import { useEffect, useState } from "react";
import type { AppModel } from "../appModel.ts";
import type { Note } from "../core/types.ts";
import type { LocalAttachment } from "../core/attachment/store.ts";
import { newAttachment } from "../core/attachment/store.ts";
import { sha256HexBytes } from "../core/attachment/crypto.ts";
import { bytesToBase64 } from "../core/base64.ts";
import { parseExcalidrawJson, excalidrawToSvg } from "../core/excalidraw.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  note: Note;
  lang: Lang;
}

/** Editor + the note's attachment library (previews, upload, download, remove). */
export function NotePane({ model, note, lang }: Props) {
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState("");

  async function reload() {
    const list = await model.attachmentStore.byNote(note.id);
    setAttachments(list);
    const next: Record<string, string> = {};
    for (const a of list) {
      if (a.kind === "diagram" && a.hasPayload) {
        const bytes = await model.attachmentStore.payload(a.id);
        if (bytes) {
          try {
            const parsed = parseExcalidrawJson(new TextDecoder().decode(bytes));
            if (parsed.ok) {
              const svg = excalidrawToSvg(parsed.elements, 640, 360);
              next[a.id] = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
            }
          } catch {
            /* preview is best-effort */
          }
        }
        continue;
      }
      if (a.kind !== "image" || !a.hasPayload) continue;
      const bytes = await model.attachmentStore.payload(a.id);
      if (bytes) {
        next[a.id] = `data:${a.mime || "image/png"};base64,${bytesToBase64(bytes)}`;
      }
    }
    setPreviews(next);
  }

  useEffect(() => {
    void reload();
    return model.attachmentStore.subscribe(() => void reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, note.id]);

  async function attach(file: File) {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha = await sha256HexBytes(bytes);
      const meta = newAttachment(
        note.id,
        file.name,
        file.type || "application/octet-stream",
        bytes.length,
        sha,
      );
      await model.attachmentStore.savePayload(meta, bytes);
      model.noteStore.touch(note.id);
      void model.analyzeAttachment(meta.id);
    } catch (e) {
      setError(
        t(lang, "editor.attachment.failed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  async function download(a: LocalAttachment) {
    const bytes = await model.attachmentStore.payload(a.id);
    if (!bytes) return;
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: a.mime || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = a.fileName || a.id;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function setDue(date: string | null) {
    const map = { ...model.settingsStore.get().noteDueOns };
    if (date) map[note.id] = date;
    else delete map[note.id];
    await model.settingsStore.update({ noteDueOns: map });
  }

  async function remove(a: LocalAttachment) {
    await model.attachmentStore.remove(a.id);
    model.noteStore.touch(note.id);
  }

  async function hideFromAi(id: string, hidden: boolean) {
    const cur = model.settingsStore.get().aiHiddenNoteIds ?? [];
    const next = hidden ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    await model.settingsStore.update({ aiHiddenNoteIds: next });
  }

  async function ingestLink() {
    const url = linkDraft.trim();
    if (!url) return;
    setError(null);
    const r = await model.ingestLink(note.id, url);
    if (r.ok) {
      setLinkDraft("");
    } else {
      setError(
        t(lang, "editor.link.failed", { detail: r.detail ?? "" }),
      );
    }
  }

  return (
    <>
      {error && <div className="banner">{error}</div>}
      <div className="row">
        <input
          className="link-ingest"
          placeholder={t(lang, "editor.link.placeholder")}
          value={linkDraft}
          onChange={(e) => setLinkDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ingestLink();
          }}
        />
        <button
          type="button"
          className="button"
          disabled={!linkDraft.trim()}
          onClick={() => void ingestLink()}
        >
          {t(lang, "editor.link.ingest")}
        </button>
      </div>
      <NoteEditor
        note={note}
        lang={lang}
        attachments={attachments}
        previews={previews}
        onAttach={(file) => void attach(file)}
        onDownloadAttachment={(a) => void download(a)}
        onRemoveAttachment={(a) => void remove(a)}
        dueOn={model.settingsStore.get().noteDueOns[note.id]}
        onDue={(date) => void setDue(date)}
        hiddenFromAi={(model.settingsStore.get().aiHiddenNoteIds ?? []).includes(note.id)}
        onHideFromAi={(id, hidden) => void hideFromAi(id, hidden)}
        onBody={(id, body) => model.noteStore.updateBody(id, body)}
        onTitle={(id, title) => model.noteStore.setTitle(id, title)}
        onPin={(id) => model.noteStore.togglePin(id)}
        onArchive={(id, archived) => model.noteStore.setArchived(id, archived)}
        onDelete={(id) => model.noteStore.delete(id)}
        onColor={(id, color) => model.noteStore.setColor(id, color)}
        onMove={(id, by) => model.noteStore.reorder(id, by)}
      />
    </>
  );
}
