/**
 * Facade: sniff by content, dispatch to the format parser, render through the
 * single GFM serializer, and classify every failure. Never throws.
 * Port of Android's TextExtractor.kt.
 */
import { extractHtml } from "./html.ts";
import { extractDocx, extractPptx, extractXlsx } from "./ooxml.ts";
import { extractPdf } from "./pdf.ts";
import { extractCsv, extractPlainText } from "./simple.ts";
import { sniff, zipEntryNames } from "./sniff.ts";
import type { DocModel, ExtractError, Extraction } from "./types.ts";
import { ExtractFailure, Limits } from "./types.ts";
import { renderGfm } from "./gfm.ts";

export type { ExtractError, Extraction } from "./types.ts";

/**
 * Extracts the text layer of one attachment payload as GFM markdown.
 * The declared attachment size cap is checked first (Android passes the bytes
 * whole; callers on Windows read the payload before dispatch, so the cap is
 * enforced here against the buffer length, mirroring bytes.size).
 *
 * `mime` is carried in the signature for the Windows ingest call site; like
 * Android's TextExtractor, detection itself sniffs purely from content+name.
 */
export async function extractText(
  fileName: string,
  mime: string,
  bytes: Uint8Array,
): Promise<Extraction> {
  void mime;
  if (bytes.length > Limits.MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: {
        kind: "resource_limit",
        detail: `attachment exceeds ${Limits.MAX_ATTACHMENT_BYTES} bytes`,
      },
    };
  }
  const head = bytes.subarray(0, Math.min(8192, bytes.length));
  const sniffed = sniff(head, fileName, () => {
    try {
      return zipEntryNames(bytes);
    } catch {
      return null;
    }
  });
  switch (sniffed) {
    case "pdf":
      return await extractPdf(bytes);
    case "docx":
      return await render("docx", () => extractDocx(bytes));
    case "xlsx":
      return await render("xlsx", () => extractXlsx(bytes));
    case "pptx":
      return await render("pptx", () => extractPptx(bytes));
    case "odf":
      return { ok: false, error: { kind: "unsupported", detail: "odf" } };
    case "ole":
      return { ok: false, error: { kind: "unsupported", detail: "legacy office (ole)" } };
    case "html":
      return await render("html", () => extractHtml(bytes));
    case "csv":
      return await render("csv", () => extractCsv(bytes));
    case "txt":
      return await render("txt", () => extractPlainText(bytes));
    case "md":
      return await render("md", () => extractPlainText(bytes));
    case "unknown":
      return { ok: false, error: { kind: "unsupported", detail: "unknown" } };
  }
}

async function render(format: string, parse: () => DocModel): Promise<Extraction> {
  try {
    let md = renderGfm(parse());
    if (md.length > Limits.MAX_TEXT_CHARS) md = md.slice(0, Limits.MAX_TEXT_CHARS);
    if (md.trim().length === 0) {
      return { ok: false, error: { kind: "malformed", detail: "no content extracted" } };
    }
    return { ok: true, markdown: md, format };
  } catch (e) {
    if (e instanceof ExtractFailure) {
      const error: ExtractError = { kind: e.error.kind, detail: e.error.detail };
      return { ok: false, error };
    }
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { kind: "malformed", detail: detail || `failed to parse ${format}` } };
  }
}

export type { DocModel };
