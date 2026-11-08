/**
 * OOXML extractors (docx / xlsx / pptx), ported from Android's
 * DocxExtractor.kt / XlsxExtractor.kt / PptxExtractor.kt. All parts come out
 * of the ZIP container through a shared budget; XML is pull-parsed with local
 * names only, under a node guard.
 */
import type { Block, DocModel, Inline } from "./types.ts";
import { malformedPart, plain } from "./types.ts";
import { entryNames, readEntry, ZipBudget } from "./zip.ts";
import { NodeGuard, XmlPull } from "./xml.ts";

// ---- docx -------------------------------------------------------------------

/**
 * docx: parses word/document.xml out of the ZIP container with a pull parser.
 * Headings come from pStyle ids ("Heading1"...), numPr marks bullet items,
 * w:tbl becomes a table. Namespace-agnostic: local names only.
 */
export function extractDocx(zip: Uint8Array): DocModel {
  const budget = new ZipBudget();
  const xml = readEntry(zip, "word/document.xml", budget);
  if (!xml) throw malformedPart("missing word/document.xml");
  return parseDocxXml(xml);
}

export function parseDocxXml(xml: Uint8Array): DocModel {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const blocks: Block[] = [];

  // Current paragraph/run state.
  let inParagraph = false;
  let paraStyle = "";
  let paraIsList = false;
  let paraInlines: Inline[] = [];
  let inRun = false;
  let runBold = false;
  let runItalic = false;
  let runText = "";

  // Table state.
  let inTable = false;
  let rows: Inline[][][] = [];
  let rowCells: Inline[][] = [];
  let cellParas: Inline[][] = [];
  let cellDepth = 0; // paragraphs collected for the current cell

  const flushRun = () => {
    if (runText.length > 0) {
      paraInlines.push({ kind: "text", text: runText, bold: runBold, italic: runItalic, code: false });
      runText = "";
    }
  };
  const flushParagraph = () => {
    flushRun();
    const inl = paraInlines;
    paraInlines = [];
    const hasText = inl.some((i) => (i.kind === "text" && i.text.trim().length > 0) || i.kind === "link");
    if (inTable && cellDepth > 0) {
      if (hasText) cellParas.push(inl);
      return;
    }
    if (!hasText) return;
    const level = headingLevel(paraStyle);
    if (level !== null) blocks.push({ kind: "heading", level, inlines: inl });
    else if (paraIsList) blocks.push({ kind: "bulletList", items: [inl] });
    else blocks.push({ kind: "paragraph", inlines: inl });
    paraStyle = "";
    paraIsList = false;
  };

  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag") {
      switch (p.local) {
        case "tbl":
          inTable = true;
          rows = [];
          break;
        case "tr":
          if (inTable) rowCells = [];
          break;
        case "tc":
          if (inTable) {
            cellParas = [];
            cellDepth++;
          }
          break;
        case "p":
          inParagraph = true;
          paraStyle = "";
          paraIsList = false;
          paraInlines = [];
          break;
        case "pStyle":
          paraStyle = p.attrLocal("val") ?? "";
          break;
        case "numPr":
          paraIsList = true;
          break;
        case "r":
          inRun = true;
          runBold = false;
          runItalic = false;
          break;
        case "b":
          if (inRun) runBold = true;
          break;
        case "i":
          if (inRun) runItalic = true;
          break;
        case "t":
          if (inParagraph) runText += p.nextText();
          break;
        case "tab":
          runText += " ";
          break;
        case "br":
          runText += " ";
          break;
        case "drawing":
        case "pict":
          if (!inTable) blocks.push({ kind: "image", alt: "" });
          break;
      }
    } else if (event === "endtag") {
      switch (p.local) {
        case "r":
          flushRun();
          inRun = false;
          break;
        case "p":
          flushParagraph();
          inParagraph = false;
          break;
        case "tc":
          if (inTable) {
            rowCells.push(cellParas.length > 0 ? ([] as Inline[]).concat(...cellParas) : []);
            cellDepth--;
          }
          break;
        case "tr":
          if (inTable) rows.push(rowCells);
          break;
        case "tbl":
          if (rows.length > 0) blocks.push({ kind: "table", rows });
          inTable = false;
          break;
      }
    }
  }
  return { blocks: mergeBulletLists(blocks) };
}

function headingLevel(style: string): number | null {
  const m = /heading\s*(\d)/i.exec(style);
  if (!m) return null;
  const level = Number.parseInt(m[1], 10);
  return Number.isNaN(level) ? null : Math.min(6, Math.max(1, level));
}

/** Consecutive bullet lists coalesce into one (Android mergeLists). */
export function mergeBulletLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.kind === "bulletList" && b.kind === "bulletList") {
      out[out.length - 1] = { kind: "bulletList", items: [...last.items, ...b.items] };
    } else {
      out.push(b);
    }
  }
  return out;
}

// ---- xlsx -------------------------------------------------------------------

interface SheetRef {
  name: string;
  rid: string;
}

/**
 * xlsx: shared strings + workbook sheets + sheet XML, all pull-parsed out of
 * the ZIP container. Each sheet with rows becomes a table (first row header).
 */
export function extractXlsx(zip: Uint8Array): DocModel {
  const budget = new ZipBudget();
  const sharedXml = readEntry(zip, "xl/sharedStrings.xml", budget);
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const workbook = readEntry(zip, "xl/workbook.xml", budget);
  if (!workbook) throw malformedPart("missing xl/workbook.xml");
  const relsXml = readEntry(zip, "xl/_rels/workbook.xml.rels", budget);
  const rels = relsXml ? parseRels(relsXml) : new Map<string, string>();
  const sheets = parseSheets(workbook); // name + r:id, in document order

  const blocks: Block[] = [];
  for (const sheet of sheets) {
    const target = rels.get(sheet.rid);
    if (!target) continue;
    const xml = readEntry(zip, `xl/${target}`, budget);
    if (!xml) continue;
    const rows = parseSheet(xml, shared);
    if (rows.length === 0) continue;
    blocks.push({ kind: "table", rows: rows.map((row) => row.map((cell) => plain(cell))) });
  }
  return { blocks };
}

/** xl/workbook.xml → sheets in document order. */
function parseSheets(xml: Uint8Array): SheetRef[] {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const sheets: SheetRef[] = [];
  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag" && p.local === "sheet") {
      const name = p.attr("name") ?? "Sheet";
      // r:id lives in the relationships namespace; match by local name.
      sheets.push({ name, rid: p.attrLocal("id") ?? "" });
    }
  }
  return sheets;
}

/** xl/_rels/workbook.xml.rels → rId → target path (relative to xl/). */
function parseRels(xml: Uint8Array): Map<string, string> {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const map = new Map<string, string>();
  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag" && p.local === "Relationship") {
      const id = p.attr("Id") ?? "";
      const target = p.attr("Target") ?? "";
      if (id.length > 0 && target.length > 0 && (p.attr("Type") ?? "").endsWith("/worksheet")) {
        map.set(id, target.replace(/^\/xl\//, "").replace(/^xl\//, ""));
      }
    }
  }
  return map;
}

function parseSharedStrings(xml: Uint8Array): string[] {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const strings: string[] = [];
  let cur = "";
  let inSi = false;
  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag") {
      if (p.local === "si") {
        inSi = true;
        cur = "";
      } else if (p.local === "t" && inSi) {
        cur += p.nextText();
      }
    } else if (event === "endtag" && p.local === "si") {
      strings.push(cur);
      inSi = false;
    }
  }
  return strings;
}

/** One sheet → grid rows; sparse cells are placed by their column letters. */
function parseSheet(xml: Uint8Array, shared: string[]): string[][] {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const rows: string[][] = [];
  let cells: [number, string][] = [];
  let cellCol = -1;
  let cellType = "";
  let cellValue: string | null = null;
  let inCell = false;
  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag") {
      switch (p.local) {
        case "row":
          cells = [];
          break;
        case "c":
          inCell = true;
          cellType = p.attr("t") ?? "";
          cellCol = columnIndex(p.attr("r") ?? "");
          cellValue = null;
          break;
        case "v":
          if (inCell) cellValue = p.nextText();
          break;
        case "t":
          if (inCell && cellType === "inlineStr") cellValue = p.nextText();
          break;
      }
    } else if (event === "endtag") {
      if (p.local === "c") {
        cells.push([cellCol, resolve(cellValue ?? "", cellType, shared)]);
        inCell = false;
      } else if (p.local === "row") {
        if (cells.length > 0) {
          const width = Math.max(...cells.map(([col]) => col)) + 1;
          const arr: string[] = Array.from({ length: width }, () => "");
          for (const [col, v] of cells) {
            if (col >= 0) arr[col] = v;
          }
          rows.push(arr);
        }
      }
    }
  }
  return rows;
}

function resolve(value: string, type: string, shared: string[]): string {
  switch (type) {
    case "s": {
      const idx = Number.parseInt(value, 10);
      return Number.isNaN(idx) ? "" : shared[idx] ?? "";
    }
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    default:
      return value;
  }
}

/** "B12" → 1 (0-based column); absent ref → -1 (kept out of placement). */
export function columnIndex(ref: string): number {
  let col = 0;
  let seen = false;
  for (const c of ref) {
    if (c >= "A" && c <= "Z") {
      col = col * 26 + (c.charCodeAt(0) - 65 + 1);
      seen = true;
    } else break;
  }
  return seen ? col - 1 : -1;
}

// ---- pptx -------------------------------------------------------------------

/**
 * pptx: every slide's a:p paragraphs (runs a:r/a:t) become plain paragraphs,
 * one per a:p. Speaker notes are ignored.
 */
export function extractPptx(zip: Uint8Array): DocModel {
  const budget = new ZipBudget();
  const slideRe = /^ppt\/slides\/slide\d+\.xml$/;
  const names = entryNames(zip)
    .filter((n) => slideRe.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (names.length === 0) throw malformedPart("no slides in ppt/");

  const blocks: Block[] = [];
  for (const name of names) {
    const xml = readEntry(zip, name, budget);
    if (!xml) continue;
    for (const para of parseSlide(xml)) {
      blocks.push({ kind: "paragraph", inlines: plain(para) });
    }
  }
  return { blocks };
}

function slideNumber(name: string): number {
  const m = /\d+/.exec(name);
  return m ? Number.parseInt(m[0], 10) : 0;
}

/** Slide XML → one string per a:p paragraph (runs concatenated). */
export function parseSlide(xml: Uint8Array): string[] {
  const p = new XmlPull(decode(xml));
  const guard = new NodeGuard();
  const paras: string[] = [];
  let cur = "";
  let inPara = false;
  for (;;) {
    const event = p.next();
    if (event === "enddoc") break;
    guard.tick();
    if (event === "starttag") {
      if (p.local === "p") {
        inPara = true;
        cur = "";
      } else if (p.local === "t" && inPara) {
        cur += p.nextText();
      } else if (p.local === "br" && inPara) {
        cur += " ";
      }
    } else if (event === "endtag" && p.local === "p" && inPara) {
      const s = cur.trim();
      if (s.length > 0) paras.push(s);
      inPara = false;
    }
  }
  return paras;
}

function decode(xml: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(xml);
}
