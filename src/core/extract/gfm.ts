/**
 * The single GFM serializer every parser funnels through. Blocks are joined
 * by one blank line; trailing whitespace is trimmed; the document ends with a
 * single newline. Port of Android's extract/Gfm.kt.
 */
import type { Block, DocModel, Inline } from "./types.ts";

export function renderGfm(doc: DocModel): string {
  const out: string[] = [];
  for (const block of doc.blocks) out.push(renderBlock(block));
  return out.join("\n\n").trimEnd() + "\n";
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "heading":
      return "#".repeat(block.level) + " " + renderInlines(block.inlines);
    case "paragraph":
      return renderInlines(block.inlines);
    case "bulletList":
      return block.items.map((item) => "- " + renderInlines(item)).join("\n");
    case "orderedList":
      return block.items
        .map((item, i) => `${i + 1}. ` + renderInlines(item))
        .join("\n");
    case "table":
      return renderTable(block);
    case "image":
      return `![${escapeAlt(block.alt)}]()`;
    case "code": {
      // No Android counterpart; mirrors the note-body projection's fence form.
      const fence = "```" + block.language;
      return `${fence}\n${block.text}\n\`\`\``;
    }
  }
}

function renderTable(block: ExtractBlockTable): string {
  const rows = block.rows;
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const cellText = (cell: Inline[]): string =>
    renderInlines(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim();
  const rowLine = (row: Inline[][]): string => {
    const cells: string[] = [];
    for (let col = 0; col < cols; col++) cells.push(col < row.length ? cellText(row[col]) : "");
    return "| " + cells.join(" | ") + " |";
  };
  const out: string[] = [rowLine(rows[0])];
  out.push("| " + Array.from({ length: cols }, () => "---").join(" | ") + " |");
  for (const row of rows.slice(1)) out.push(rowLine(row));
  return out.join("\n");
}

type ExtractBlockTable = Extract<Block, { kind: "table" }>;

function renderInlines(inlines: Inline[]): string {
  let out = "";
  for (const inline of inlines) {
    if (inline.kind === "text") out += styled(inline);
    else out += `[${escapeText(inline.text)}](${inline.url})`;
  }
  return out;
}

function styled(t: ExtractTextInline): string {
  let s = escapeText(t.text);
  if (t.code) s = "`" + s + "`";
  if (t.bold) s = "**" + s + "**";
  if (t.italic) s = "*" + s + "*";
  return s;
}

type ExtractTextInline = Extract<Inline, { kind: "text" }>;

/** Escape the characters that would flip meaning in GFM prose. */
export function escapeText(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "\\" || c === "`" || c === "*" || c === "_" || c === "[" || c === "]") {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

function escapeAlt(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
