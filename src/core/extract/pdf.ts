/**
 * pdf: pdfjs-dist (legacy build) strips the text layer. A scanned (image-only)
 * document has no text layer → needs_ocr; a password-protected one → encrypted.
 * Port of Android's PdfExtractor.kt (PdfBox + PDFTextStripper).
 */
import { renderGfm } from "./gfm.ts";
import { plain } from "./types.ts";
import type { Extraction } from "./types.ts";

export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  let doc: PdfDocument | undefined;
  let task: PdfLoadingTask | undefined;
  try {
    const pdfjs = await loadPdfjs();
    // Copy: pdfjs may detach the buffer it is handed.
    task = pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      isEvalSupported: false,
    });
    doc = await task.promise;
  } catch (e) {
    if (e instanceof Error && (e.name === "PasswordException" || /password/i.test(message(e) ?? ""))) {
      return { ok: false, error: { kind: "encrypted" } };
    }
    return { ok: false, error: { kind: "malformed", detail: message(e) ?? "pdf parse failed" } };
  }
  try {
    let text = "";
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      text += pageText(content.items) + "\n";
    }
    if (text.trim().length === 0) {
      return { ok: false, error: { kind: "needs_ocr" } };
    }
    const paras = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => ({ kind: "paragraph" as const, inlines: plain(p.replace(/\n/g, " ")) }));
    return { ok: true, markdown: renderGfm({ blocks: paras }), format: "pdf" };
  } catch (e) {
    return { ok: false, error: { kind: "malformed", detail: message(e) ?? "pdf parse failed" } };
  } finally {
    // PDFDocumentProxy has no destroy in pdfjs v6; the loading task owns it.
    await task?.destroy();
  }
}

/**
 * Joins one page's text items in reading order, mirroring Android's
 * PDFTextStripper(sortByPosition): lines are clusters of items at the same
 * y (top of the page first), ordered left to right, with a space inserted
 * across visible gaps. pdfjs's own hasEOL only fires on explicit line
 * operators, so ET/BT-split runs would glue together without this.
 */
function pageText(items: PdfTextItem[]): string {
  const parts = items.filter((it) => typeof it.str === "string");
  if (parts.length === 0) return "";
  const geo = parts.map((it) => {
    const tr = (it.transform ?? [1, 0, 0, 1, 0, 0]) as number[];
    return {
      str: it.str as string,
      x: tr[4],
      y: tr[5],
      w: it.width ?? 0,
      h: Math.abs(tr[3]) || Math.abs(tr[0]) || 10,
    };
  });
  geo.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines: string[] = [];
  let line: typeof geo = [];
  const flush = (): void => {
    if (line.length === 0) return;
    line.sort((a, b) => a.x - b.x);
    let s = "";
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const item of line) {
      if (s.length > 0 && item.x - prevEnd > item.h * 0.2 &&
          !s.endsWith(" ") && !item.str.startsWith(" ")) {
        s += " ";
      }
      s += item.str;
      prevEnd = item.x + item.w;
    }
    lines.push(s.trim());
    line = [];
  };
  let lineY = Number.NaN;
  for (const item of geo) {
    if (Number.isNaN(lineY) || Math.abs(item.y - lineY) > 2) {
      flush();
      lineY = item.y;
    }
    line.push(item);
  }
  flush();
  return lines.filter((l) => l.length > 0).join("\n");
}

async function loadPdfjs(): Promise<PdfjsModule> {
  // Structural cast: the package's own types model far more surface than the
  // text-extraction slice this module needs.
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  // Main-thread parsing: the real Web Worker needs an asset URL the bundler
  // cannot know here (and Node tests have no worker at all). Preloading the
  // worker message handler is pdfjs's documented "disable the worker" hook;
  // a host can still opt into a real worker by setting globalThis.pdfjsWorker
  // (or GlobalWorkerOptions.workerSrc) before calling extractText.
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) {
    g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  }
  return pdfjs;
}

function message(e: unknown): string | undefined {
  return e instanceof Error ? e.message : String(e);
}

// Minimal structural types for the pdfjs surface this module touches; the
// package ships its own .d.ts but the legacy build import is dynamic.
interface PdfTextItem {
  str?: string;
  width?: number;
  transform?: number[];
  hasEOL?: boolean;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(src: {
    data: Uint8Array;
    useWorkerFetch: boolean;
    isEvalSupported: boolean;
  }): PdfLoadingTask;
}
