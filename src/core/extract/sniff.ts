/**
 * Content-based format detection; the extension is only a fallback.
 * Port of Android's extract/FormatSniff.kt (same precedence).
 */
import { eocd, type ZipCentralDirectory } from "./zip.ts";

export type Sniffed =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odf"
  | "ole"
  | "html"
  | "csv"
  | "txt"
  | "md"
  | "unknown";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function sniff(head: Uint8Array, fileName: string, zipEntries?: () => string[] | null): Sniffed {
  if (startsWith(head, "%PDF-")) return "pdf";
  if (startsWithBytes(head, OLE_MAGIC)) return "ole";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) {
    const entries = zipEntries ? zipEntries() : null;
    if (!entries) return "unknown";
    return sniffZip(entries);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "html";

  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const noExt = fileName.lastIndexOf(".") < 0 ? "" : ext;
  switch (noExt) {
    case "csv":
      return "csv";
    case "txt":
      return "txt";
    case "md":
    case "markdown":
      return "md";
    case "html":
    case "htm":
      return "html";
    case "docx":
      return "docx";
    case "xlsx":
      return "xlsx";
    case "pptx":
      return "pptx";
    case "pdf":
      return "pdf";
    default:
      return "unknown";
  }
}

/** ZIP containers: look at well-known member names (OOXML) or the ODF mimetype. */
export function sniffZip(entries: string[]): Sniffed {
  const set = new Set(entries);
  if (set.has("word/document.xml")) return "docx";
  if (set.has("xl/workbook.xml")) return "xlsx";
  if (set.has("ppt/presentation.xml")) return "pptx";
  if (set.has("mimetype")) return "odf";
  return "unknown";
}

/** Lists entry names of a ZIP payload without decompressing entry data. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const cd: ZipCentralDirectory | null = eocd(bytes);
  return cd ? cd.entries.map((e) => e.name) : [];
}

function startsWith(head: Uint8Array, ascii: string): boolean {
  const magic = new TextEncoder().encode(ascii);
  return startsWithBytes(head, magic);
}

function startsWithBytes(head: Uint8Array, magic: ArrayLike<number>): boolean {
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (head[i] !== magic[i]) return false;
  }
  return true;
}
