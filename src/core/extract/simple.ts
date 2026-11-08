/**
 * txt/md/csv passthrough. Port of Android's SimpleExtractors.kt.
 */
import type { Block, DocModel } from "./types.ts";
import { plain } from "./types.ts";

/** txt/md: read as UTF-8 and wrap as one paragraph per blank-line chunk. */
export function extractPlainText(bytes: Uint8Array): DocModel {
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const paras: Block[] = text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ kind: "paragraph", inlines: plain(chunk.replace(/\n/g, " ")) }));
  return { blocks: paras };
}

/** RFC-4180-ish CSV: quoted fields, `""` escapes, CRLF/LF. First row is the header. */
export function extractCsv(bytes: Uint8Array): DocModel {
  const rows = parseCsv(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  if (rows.length === 0) return { blocks: [] };
  return {
    blocks: [{ kind: "table", rows: rows.map((row) => row.map((cell) => plain(cell))) }],
  };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && i + 1 < text.length && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field.length === 0) {
      inQuotes = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      if (i + 1 < text.length && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
    }
    i++;
  }
  if (field.length > 0 || row.length > 0) endRow();
  // Drop trailing all-empty rows.
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim().length === 0)) {
    rows.pop();
  }
  return rows;
}
