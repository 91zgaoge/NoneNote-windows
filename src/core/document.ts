import type { Attachment, Note, NoteBlock, NoteDocument } from "./types.ts";
import { PARSE_EMPTY, PARSE_FAILED } from "./types.ts";

export const TASK_OPEN = "☐";
export const TASK_DONE = "☑";
const IMAGE_BUDGET = 4000;
const FAILURE_PREFIX = "Fetch failed:";
const TRUNCATION_MARKER =
  "\n[... truncated: this note alone exceeded the prompt budget ...]";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const IMAGE_RE = /^!\[(.*?)]\((.*?)\)\s*$/;
const FENCE_OPEN_RE = /^```(\w*)\s*$/;
const ATTACHMENT_SCHEME = "attachment:";

export function parseAttachmentUri(url: string): string | null {
  const t = url.trim();
  if (!t.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = t.slice(ATTACHMENT_SCHEME.length).trim();
  return id.length > 0 ? id : null;
}

function taskMarker(line: string): string | null {
  const first = line.charAt(0);
  return first === TASK_OPEN || first === TASK_DONE ? first : null;
}

function taskStripped(line: string): string {
  return taskMarker(line) !== null ? line.slice(1).trim() : line;
}

/** Parse note markdown (☐/☑ tasks included) into the Android block document shape. */
export function parseMarkdown(markdown: string): NoteDocument {
  if (markdown.length === 0) return { schemaVersion: 1, blocks: [] };
  const blocks: NoteBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      const language = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: body.join("\n"), language });
      continue;
    }
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (taskMarker(line) !== null) {
      blocks.push({
        type: "task",
        checked: taskMarker(line) === TASK_DONE,
        text: taskStripped(line),
      });
    } else {
      const heading = line.match(HEADING_RE);
      const image = line.trim().match(IMAGE_RE);
      const quote = line.match(QUOTE_RE);
      const bullet = line.match(BULLET_RE);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      } else if (image) {
        const att = parseAttachmentUri(image[2]);
        if (att) blocks.push({ type: "image", attachmentId: att, alt: image[1] });
        else blocks.push({ type: "paragraph", text: line.trim() });
      } else if (quote) {
        blocks.push({ type: "quote", text: quote[1] });
      } else if (bullet) {
        blocks.push({ type: "bullet", text: bullet[1] });
      } else {
        blocks.push({ type: "paragraph", text: line });
      }
    }
    i++;
  }
  return { schemaVersion: 1, blocks };
}

export function resolvedDocument(n: Note): NoteDocument {
  if (n.document && Array.isArray(n.document.blocks)) return n.document;
  return parseMarkdown(n.body);
}

/** GFM + ☐/☑ projection, matching Android's GfmProjection. */
export function projectDocument(doc: NoteDocument): string {
  if (doc.blocks.length === 0) return "";
  let out = "";
  let prevNeedsBlank = false;
  for (const b of doc.blocks) {
    let chunk = "";
    switch (b.type) {
      case "paragraph":
        chunk = b.text ?? "";
        break;
      case "heading":
        chunk = "#".repeat(Math.max(1, Math.min(6, b.level ?? 1))) + " " + (b.text ?? "");
        break;
      case "task":
        chunk = (b.checked ? TASK_DONE : TASK_OPEN) + " " + (b.text ?? "");
        break;
      case "bullet":
        chunk = "- " + (b.text ?? "");
        break;
      case "quote":
        chunk = "> " + (b.text ?? "");
        break;
      case "code": {
        const fence = ("```" + (b.language ?? "")).trimEnd();
        chunk = fence + "\n" + (b.text ?? "") + "\n```";
        break;
      }
      case "image": {
        const alt = (b.alt ?? "").replace(/]/g, "\\]");
        chunk = `![${alt}](${ATTACHMENT_SCHEME}${b.attachmentId ?? ""})`;
        break;
      }
      case "canvas": {
        const title = (b.title ?? "").trim() || "diagram";
        chunk = `[${title}](${ATTACHMENT_SCHEME}${b.attachmentId ?? ""})`;
        break;
      }
      default:
        continue;
    }
    if (out.length > 0) {
      const needsBlank =
        prevNeedsBlank ||
        b.type === "heading" ||
        b.type === "code" ||
        b.type === "image" ||
        b.type === "canvas";
      out += needsBlank ? "\n\n" : "\n";
    }
    out += chunk;
    prevNeedsBlank =
      b.type === "heading" ||
      b.type === "code" ||
      b.type === "image" ||
      b.type === "canvas" ||
      b.type === "quote";
  }
  return out;
}

export function usableAttachmentText(a: Attachment | undefined): string {
  if (!a) return "";
  if (a.parseStatus === PARSE_FAILED || a.parseStatus === PARSE_EMPTY) return "";
  if (a.extractedText.startsWith(FAILURE_PREFIX)) return "";
  return a.aiSummary || a.extractedText;
}

/**
 * Reading-order projection for model prompts, with the same hard character
 * budget as Android's `DocumentProjection.forAi`.
 */
export function documentProjectionForAi(
  note: Note,
  attachments: Attachment[] = [],
  maxChars = Number.MAX_SAFE_INTEGER,
): string {
  const doc = resolvedDocument(note);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const referenced = new Set(
    doc.blocks
      .filter((b) => b.type === "image" || b.type === "canvas")
      .map((b) => b.attachmentId ?? ""),
  );
  let out = "";

  const appendWithinBudget = (text: string): boolean => {
    const room = maxChars - out.length;
    if (text.length <= room) {
      out += text;
      return true;
    }
    if (room > 0) out += text.slice(0, room);
    out += TRUNCATION_MARKER;
    return false;
  };

  if (
    !appendWithinBudget(
      "NOTE id=" + note.id + " title=" + note.title.replace(/\n/g, " ") + "\n",
    )
  ) {
    return out.trimEnd();
  }

  for (const b of doc.blocks) {
    let line = "";
    switch (b.type) {
      case "paragraph":
        line = "[paragraph] " + (b.text ?? "") + "\n";
        break;
      case "heading":
        line = "[heading" + (b.level ?? 1) + "] " + (b.text ?? "") + "\n";
        break;
      case "task":
        line = "[task] " + (b.checked ? TASK_DONE : TASK_OPEN) + " " + (b.text ?? "") + "\n";
        break;
      case "bullet":
        line = "[bullet] " + (b.text ?? "") + "\n";
        break;
      case "quote":
        line = "[quote] " + (b.text ?? "") + "\n";
        break;
      case "code":
        line = "[code] " + (b.text ?? "") + "\n";
        break;
      case "image": {
        const summary = usableAttachmentText(byId.get(b.attachmentId ?? ""));
        line = `[image ${b.attachmentId}] alt=${b.alt ?? ""}\n`;
        if (summary) line += "<" + summary.slice(0, IMAGE_BUDGET) + ">\n";
        break;
      }
      case "canvas": {
        const summary = usableAttachmentText(byId.get(b.attachmentId ?? ""));
        line = `[canvas ${b.attachmentId}] ${b.title ?? ""}\n`;
        if (summary) line += "<" + summary.slice(0, IMAGE_BUDGET) + ">\n";
        break;
      }
      default:
        line = "[unknown:" + (b.rawType ?? b.type) + "]\n";
        break;
    }
    if (!appendWithinBudget(line)) return out.trimEnd();
  }

  for (const a of [...attachments].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (referenced.has(a.id)) continue;
    const text = usableAttachmentText(a);
    if (!text.trim()) continue;
    const block =
      "--- attachment: " +
      a.fileName.replace(/\n/g, " ") +
      " (" +
      a.kind +
      ") ---\n" +
      text.slice(0, IMAGE_BUDGET) +
      "\n";
    if (!appendWithinBudget(block)) return out.trimEnd();
  }
  return out.trimEnd();
}

/** Stable string for hashing document structure (volatile summaries excluded). */
export function structuralKey(doc: NoteDocument): string {
  let out = "v" + (doc.schemaVersion ?? 1);
  for (const b of doc.blocks) {
    out += "\u0000";
    switch (b.type) {
      case "paragraph":
        out += "p\u0000" + (b.text ?? "");
        break;
      case "heading":
        out += "h" + (b.level ?? 1) + "\u0000" + (b.text ?? "");
        break;
      case "task":
        out += "t\u0000" + (b.checked ? "1" : "0") + "\u0000" + (b.text ?? "");
        break;
      case "bullet":
        out += "b\u0000" + (b.text ?? "");
        break;
      case "quote":
        out += "q\u0000" + (b.text ?? "");
        break;
      case "code":
        out += "c\u0000" + (b.language ?? "") + "\u0000" + (b.text ?? "");
        break;
      case "image":
        out += "i\u0000" + (b.attachmentId ?? "") + "\u0000" + (b.alt ?? "");
        break;
      case "canvas":
        out += "cv\u0000" + (b.attachmentId ?? "") + "\u0000" + (b.title ?? "");
        break;
      default:
        out += "u\u0000" + (b.rawType ?? "") + "\u0000" + JSON.stringify(b.raw ?? null);
        break;
    }
  }
  return out;
}
