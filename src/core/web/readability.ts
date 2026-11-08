/**
 * Readability-style main-content extraction — port of Android's web/
 * WebReadability.kt funnelled through extract/HtmlExtractor.kt + extract/
 * Gfm.kt (the DocModel→GFM serializer conventions). Self-contained: operates
 * on the HTML string with a lightweight tokenizer, no DOM dependency.
 *
 * Strategy, per the Android design: prefer semantic containers
 * (article/main/[role=main]); otherwise fall back to text-density scoring —
 * paragraph text weighted by comma count, penalized by link density (Mozilla
 * Readability's approach). Boilerplate (nav/header/footer/aside, script/style,
 * and class/id unlikely-candidates) is removed first. Returns null when
 * nothing readable survives.
 */

// ---------- limits (Android extract/Limits.kt) ----------

/** Extracted text is truncated past this many characters. */
export const MAX_TEXT_CHARS = 1_000_000;

/** Semantic container with less text than this is not trusted as content. */
export const MIN_SEMANTIC_CHARS = 80;

// ---------- WebReadability.kt vocabulary ----------

const UNLIKELY_RE =
  /comment|footer|footnote|sidebar|sponsor|promo|related|share|social|navbar|nav-|menu|banner|cookie|subscribe|newsletter|widget|masthead|outbrain|ad-|-ad|ads/i;

/** Positive overrides: never strip these even when an unlikely keyword matches. */
const POSITIVE_RE = /article|body|content|entry|main|page|post|text|blog|story/i;

const SEMANTIC_TAGS = new Set(["article", "main"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const HARD_NOISE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "form",
  "iframe",
  "svg",
  "canvas",
  "button",
  "select",
]);
const BLOCK_ROLES = new Set(["navigation", "banner", "contentinfo", "search"]);

// ---------- lightweight HTML tokenizer ----------

interface HtmlText {
  kind: "text";
  text: string;
}

interface HtmlElem {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlChild[];
  parent: HtmlElem | null;
}

type HtmlChild = HtmlElem | HtmlText;

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Content is raw text until the matching close tag (script/style dropped later). */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201D",
  ldquo: "\u201C",
  middot: "\u00B7",
  laquo: "\u00AB",
  raquo: "\u00BB",
  bull: "\u2022",
  dagger: "\u2020",
  deg: "\u00B0",
  plusmn: "\u00B1",
  times: "\u00D7",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
  sect: "\u00A7",
  para: "\u00B6",
  eacute: "\u00E9",
  egrave: "\u00E8",
  agrave: "\u00E0",
  ccedil: "\u00E7",
  uuml: "\u00FC",
  ouml: "\u00F6",
  auml: "\u00E4",
  szlig: "\u00DF",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);?/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** End of a start tag, honoring quoted attribute values that may contain '>'. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && !/[\s=]/.test(src[i])) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = src.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === "=") {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      let value = "";
      if (src[i] === '"' || src[i] === "'") {
        const quote = src[i];
        i++;
        const end = src.indexOf(quote, i);
        if (end < 0) {
          value = src.slice(i);
          i = n;
        } else {
          value = src.slice(i, end);
          i = end + 1;
        }
      } else {
        const vStart = i;
        while (i < n && !/\s/.test(src[i])) i++;
        value = src.slice(vStart, i);
      }
      attrs[name] = decodeEntities(value);
    } else {
      attrs[name] = "";
    }
  }
  return attrs;
}

export function parseHtml(html: string): HtmlElem {
  const root: HtmlElem = { kind: "element", tag: "#root", attrs: {}, children: [], parent: null };
  const stack: HtmlElem[] = [root];
  const top = (): HtmlElem => stack[stack.length - 1];
  const pushText = (owner: HtmlElem, raw: string): void => {
    if (raw.length > 0) owner.children.push({ kind: "text", text: decodeEntities(raw) });
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(top(), html.slice(i));
      break;
    }
    if (lt > i) pushText(top(), html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const gt = html.indexOf(">", lt);
      if (gt < 0) break;
      const tag = html.slice(lt + 2, gt).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      pushText(top(), html.slice(lt + 1));
      break;
    }
    const src = html.slice(lt + 1, gt);
    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(src);
    if (nameMatch === null) {
      pushText(top(), html.slice(lt, lt + 1));
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(src);
    const el: HtmlElem = {
      kind: "element",
      tag,
      attrs: parseAttrs(src.slice(nameMatch[1].length)),
      children: [],
      parent: top(),
    };
    top().children.push(el);
    i = gt + 1;
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const closeIdx = html.toLowerCase().indexOf(`</${tag}`, i);
      const raw = closeIdx < 0 ? html.slice(i) : html.slice(i, closeIdx);
      if (tag === "title" || tag === "textarea") pushText(el, raw);
      const closeGt = closeIdx < 0 ? -1 : html.indexOf(">", closeIdx);
      i = closeGt < 0 ? n : closeGt + 1;
    } else if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(el);
    }
  }
  return root;
}

// ---------- tree helpers (Jsoup-ish) ----------

function descendants(el: HtmlElem): HtmlElem[] {
  const out: HtmlElem[] = [];
  const visit = (e: HtmlElem): void => {
    for (const c of e.children) {
      if (c.kind === "element") {
        out.push(c);
        visit(c);
      }
    }
  };
  visit(el);
  return out;
}

function firstByTag(el: HtmlElem, tag: string): HtmlElem | null {
  for (const c of el.children) {
    if (c.kind === "element") {
      if (c.tag === tag) return c;
      const found = firstByTag(c, tag);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Normalized text of the subtree (Jsoup Element.text() approximation). */
function elText(el: HtmlElem): string {
  let buf = "";
  const visit = (e: HtmlElem): void => {
    for (const c of e.children) {
      if (c.kind === "text") buf += c.text + " ";
      else {
        visit(c);
        buf += " ";
      }
    }
  };
  visit(el);
  return buf.replace(/\s+/g, " ").trim();
}

function detach(el: HtmlElem): void {
  const parent = el.parent;
  if (parent === null) return;
  const idx = parent.children.indexOf(el);
  if (idx >= 0) parent.children.splice(idx, 1);
  el.parent = null;
}

function insideSemantic(el: HtmlElem): boolean {
  if (SEMANTIC_TAGS.has(el.tag)) return true;
  for (let p = el.parent; p !== null; p = p.parent) {
    if (SEMANTIC_TAGS.has(p.tag)) return true;
  }
  return el.attrs.role === "main";
}

// ---------- WebReadability.kt pipeline ----------

export interface ReadabilityResult {
  title: string;
  markdown: string;
}

/** og:title beats <title>; a leading h1 is the last resort (read before stripping). */
function pageTitle(root: HtmlElem): string {
  const og = descendants(root).find(
    (el) => el.tag === "meta" && el.attrs.property === "og:title",
  );
  if (og !== undefined) {
    const content = (og.attrs.content ?? "").trim();
    if (content !== "") return content;
  }
  const titleEl = firstByTag(root, "title");
  if (titleEl !== null) {
    const t = elText(titleEl);
    if (t !== "") return t;
  }
  const h1 = firstByTag(root, "h1");
  if (h1 !== null) return elText(h1);
  return "";
}

function contentRoot(body: HtmlElem): HtmlElem {
  let semantic: HtmlElem | null = null;
  let semanticLen = -1;
  for (const el of descendants(body)) {
    if (el.tag !== "article" && el.tag !== "main" && el.attrs.role !== "main") continue;
    const len = elText(el).length;
    if (len > semanticLen) {
      semantic = el;
      semanticLen = len;
    }
  }
  if (semantic !== null && semanticLen >= MIN_SEMANTIC_CHARS) return semantic;
  let best: HtmlElem | null = null;
  let bestScore = 0;
  for (const el of descendants(body)) {
    if (el.tag !== "div" && el.tag !== "section") continue;
    const score = densityScore(el);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best ?? body;
}

/**
 * Paragraph text length plus a comma bonus, scaled by (1 - link density):
 * prose scores high, link farms and nav remnants score near zero.
 */
function densityScore(el: HtmlElem): number {
  const text = elText(el).length;
  if (text === 0) return 0;
  let paraText = 0;
  let commas = 0;
  let linkText = 0;
  for (const d of descendants(el)) {
    if (d.tag === "p") {
      const t = elText(d);
      paraText += t.length;
      for (const ch of t) {
        if (ch === "," || ch === "\uFF0C") commas++;
      }
    } else if (d.tag === "a") {
      linkText += elText(d).length;
    }
  }
  const linkDensity = Math.min(1, Math.max(0, linkText / text));
  return (paraText + commas * 20) * (1 - linkDensity);
}

// ---------- DocModel (extract/DocModel.kt) ----------

type Inline =
  | { kind: "text"; text: string; bold: boolean; italic: boolean; code: boolean }
  | { kind: "link"; text: string; url: string };

type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "bulletList"; items: Inline[][] }
  | { kind: "orderedList"; items: Inline[][] }
  | { kind: "table"; rows: Inline[][][] }
  | { kind: "image"; alt: string };

function plainText(text: string): Inline {
  return { kind: "text", text, bold: false, italic: false, code: false };
}

/** html: headings/lists/tables become DocModel blocks (HtmlExtractor.extractFrom). */
function extractBlocks(rootEl: HtmlElem): Block[] {
  const blocks: Block[] = [];
  for (const child of rootEl.children) walkBlock(child, blocks);
  return mergeAdjacentLists(blocks);
}

function walkBlock(node: HtmlChild, out: Block[]): void {
  if (node.kind === "text") {
    const t = node.text.trim();
    if (t !== "") out.push({ kind: "paragraph", inlines: [plainText(t)] });
    return;
  }
  const heading = /^h([1-6])$/.exec(node.tag);
  if (heading !== null) {
    out.push({ kind: "heading", level: Number(heading[1]), inlines: inlineChildren(node) });
    return;
  }
  if (node.tag === "p") {
    const inl = inlineChildren(node);
    if (inl.length > 0) out.push({ kind: "paragraph", inlines: inl });
    return;
  }
  if (node.tag === "ul" || node.tag === "ol") {
    const items: Inline[][] = [];
    for (const c of node.children) {
      if (c.kind === "element" && c.tag === "li") {
        const inl = inlineChildren(c);
        if (inl.length > 0) items.push(inl);
      }
    }
    if (items.length > 0) {
      out.push(node.tag === "ul" ? { kind: "bulletList", items } : { kind: "orderedList", items });
    }
    return;
  }
  if (node.tag === "table") {
    const t = tableBlock(node);
    if (t !== null) out.push(t);
    return;
  }
  if (node.tag === "img") {
    out.push({ kind: "image", alt: (node.attrs.alt ?? "").trim() });
    return;
  }
  if (node.tag === "br") return;
  if (node.children.length > 0) {
    for (const c of node.children) walkBlock(c, out);
  }
}

/** Inline-level conversion: bold/italic/code/link wrapping their text. */
function inlineChildren(el: HtmlElem): Inline[] {
  const out: Inline[] = [];
  const rec = (n: HtmlChild, bold: boolean, italic: boolean, code: boolean): void => {
    if (n.kind === "text") {
      const t = n.text.replace(/\s+/g, " ");
      if (t.trim() !== "") out.push({ kind: "text", text: t, bold, italic, code });
      return;
    }
    switch (n.tag) {
      case "b":
      case "strong":
        for (const c of n.children) rec(c, true, italic, code);
        return;
      case "i":
      case "em":
        for (const c of n.children) rec(c, bold, true, code);
        return;
      case "code":
      case "kbd":
      case "samp":
        for (const c of n.children) rec(c, bold, italic, true);
        return;
      case "a": {
        const href = (n.attrs.href ?? "").trim();
        const label = elText(n).trim();
        if (href !== "" && label !== "") out.push({ kind: "link", text: label, url: href });
        else if (label !== "") out.push({ kind: "text", text: label, bold, italic, code });
        return;
      }
      case "br":
        out.push({ kind: "text", text: " ", bold, italic, code });
        return;
      default:
        for (const c of n.children) rec(c, bold, italic, code);
    }
  };
  for (const c of el.children) rec(c, false, false, false);
  return trimEdges(mergeAdjacentInlines(out));
}

function mergeAdjacentInlines(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of list) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (
      last !== null &&
      last.kind === "text" &&
      inline.kind === "text" &&
      last.bold === inline.bold &&
      last.italic === inline.italic &&
      last.code === inline.code
    ) {
      last.text += inline.text;
    } else {
      out.push(inline);
    }
  }
  return out;
}

/** Trim edge whitespace the collapsing introduced (first/last text inlines). */
function trimEdges(list: Inline[]): Inline[] {
  if (list.length === 0) return list;
  const out: Inline[] = [];
  list.forEach((inline, idx) => {
    if (inline.kind !== "text") {
      out.push(inline);
      return;
    }
    let text = inline.text;
    if (idx === 0) text = text.replace(/^\s+/, "");
    if (idx === list.length - 1) text = text.replace(/\s+$/, "");
    if (text !== "") out.push({ ...inline, text });
  });
  return out;
}

function tableBlock(table: HtmlElem): Block | null {
  const rows: Inline[][][] = [];
  for (const tr of descendants(table)) {
    if (tr.tag !== "tr") continue;
    const cells: Inline[][] = [];
    for (const cell of descendants(tr)) {
      if (cell.tag === "th" || cell.tag === "td") cells.push(inlineChildren(cell));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;
  return { kind: "table", rows };
}

function mergeAdjacentLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last !== null && last.kind === "bulletList" && b.kind === "bulletList") {
      last.items.push(...b.items);
    } else if (last !== null && last.kind === "orderedList" && b.kind === "orderedList") {
      last.items.push(...b.items);
    } else {
      out.push(b);
    }
  }
  return out;
}

// ---------- GFM serializer (extract/Gfm.kt) ----------

/** Escape the characters that would flip meaning in GFM prose. */
export function escapeGfmText(s: string): string {
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

function renderInlines(inlines: Inline[]): string {
  let out = "";
  for (const inline of inlines) {
    if (inline.kind === "link") {
      out += `[${escapeGfmText(inline.text)}](${inline.url})`;
      continue;
    }
    let s = escapeGfmText(inline.text);
    if (inline.code) s = "`" + s + "`";
    if (inline.bold) s = "**" + s + "**";
    if (inline.italic) s = "*" + s + "*";
    out += s;
  }
  return out;
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
      return block.items.map((item, i) => `${i + 1}. ` + renderInlines(item)).join("\n");
    case "table":
      return renderTable(block);
    case "image":
      return `![${block.alt.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}]()`;
  }
}

function renderTable(table: Extract<Block, { kind: "table" }>): string {
  const rows = table.rows;
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const cellText = (cell: Inline[]): string =>
    renderInlines(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim();
  const rowLine = (row: Inline[][]): string => {
    const cells: string[] = [];
    for (let col = 0; col < cols; col++) cells.push(col < row.length ? cellText(row[col]) : "");
    return "| " + cells.join(" | ") + " |";
  };
  const separator = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
  return [rowLine(rows[0]), separator, ...rows.slice(1).map(rowLine)].join("\n");
}

function renderGfm(blocks: Block[]): string {
  return blocks.map(renderBlock).join("\n\n").trimEnd() + "\n";
}

// ---------- entry points ----------

/**
 * Full readability extraction (Android WebReadability.extract): returns the
 * page title and the winning subtree rendered as GFM, or null when nothing
 * readable survives the boilerplate stripping.
 */
export function readabilityExtract(html: string): ReadabilityResult | null {
  const root = parseHtml(html);

  // Before chrome removal: <title>/og:title live in <head>.
  const title = pageTitle(root);

  // Hard noise: never content.
  for (const el of descendants(root)) {
    if (
      HARD_NOISE_TAGS.has(el.tag) ||
      (el.attrs.role !== undefined && BLOCK_ROLES.has(el.attrs.role)) ||
      el.attrs["aria-hidden"] === "true"
    ) {
      detach(el);
    }
  }

  // Page chrome — but a header/footer inside article/main may hold the story.
  for (const el of descendants(root)) {
    if (CHROME_TAGS.has(el.tag) && !insideSemantic(el)) detach(el);
  }

  // Unlikely candidates by class/id (unless a positive keyword overrides, or
  // the element wraps an article/main we still want).
  const body = firstByTag(root, "body") ?? root;
  for (const el of descendants(body)) {
    if (SEMANTIC_TAGS.has(el.tag) || el.tag === "body") continue;
    const hay = `${el.attrs.class ?? ""} ${el.attrs.id ?? ""}`;
    if (!UNLIKELY_RE.test(hay) || POSITIVE_RE.test(hay)) continue;
    const wrapsSemantic = descendants(el).some(
      (d) => d.tag === "article" || d.tag === "main",
    );
    if (!wrapsSemantic) detach(el);
  }

  const rootEl = contentRoot(body);
  let markdown = renderGfm(extractBlocks(rootEl)).trim();
  if (markdown.length > MAX_TEXT_CHARS) markdown = markdown.slice(0, MAX_TEXT_CHARS);
  if (markdown === "") return null;
  return { title, markdown };
}

/** Readable GFM for the page, or null when nothing readable. */
export function htmlToReadableGfm(html: string): string | null {
  const result = readabilityExtract(html);
  return result === null ? null : result.markdown;
}
