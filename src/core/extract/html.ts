/**
 * html: strips the chrome; headings/lists/tables become DocModel blocks.
 * Port of Android's HtmlExtractor.kt (jsoup semantics approximated with a
 * lightweight tokenizer + tiny DOM: script/style skip, h1-h6/p/li/table/img,
 * entity decode). No new deps.
 */
import type { Block, DocModel, Inline } from "./types.ts";
import { decodeEntities } from "./xml.ts";

interface ElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

interface TextNode {
  text: string; // decoded, not yet whitespace-normalised
}

type Node = ElementNode | TextNode;

function isElement(n: Node): n is ElementNode {
  return (n as ElementNode).tag !== undefined;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "head", "title"]);
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function extractHtml(bytes: Uint8Array): DocModel {
  const root = parseHtml(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  const body = find(root, "body") ?? root;
  const blocks: Block[] = [];
  for (const child of body.children) walk(child, blocks);
  return { blocks: mergeLists(blocks) };
}

// ---- tiny DOM ----------------------------------------------------------------

/** Parses an HTML document into a synthetic root element. */
function parseHtml(html: string): ElementNode {
  const root: ElementNode = { tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      appendText(stack, html.slice(i));
      break;
    }
    if (lt > i) appendText(stack, html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      i = skipThrough(html, lt, "-->");
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      i = skipThrough(html, lt, ">");
      continue;
    }
    if (html.startsWith("</", lt)) {
      const gt = html.indexOf(">", lt);
      if (gt < 0) break;
      const tag = html.slice(lt + 2, gt).trim().toLowerCase();
      // Pop to the nearest matching open tag; ignore unmatched end tags.
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    // Start tag.
    const gt = scanTagEnd(html, lt);
    if (gt < 0) break;
    const { tag, attrs, selfClosing } = parseStartTag(html.slice(lt + 1, gt));
    i = gt + 1;
    const el: ElementNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (RAW_TEXT_TAGS.has(tag)) {
      // Skip the subtree wholesale (Android removes script/style nodes; head
      // content never reaches the jsoup body() we walk).
      const close = html.indexOf(`</${tag}`, i);
      i = close < 0 ? html.length : skipThrough(html, close, ">");
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return root;
}

function appendText(stack: ElementNode[], raw: string): void {
  if (raw.length === 0) return;
  stack[stack.length - 1].children.push({ text: decodeEntities(raw) });
}

function parseStartTag(inner: string): { tag: string; attrs: Record<string, string>; selfClosing: boolean } {
  const selfClosing = inner.trimEnd().endsWith("/");
  const body = selfClosing ? inner.trimEnd().slice(0, -1) : inner;
  const nameM = /^[^\s/>]+/.exec(body);
  const tag = (nameM ? nameM[0] : "").toLowerCase();
  const rest = body.slice(nameM ? nameM[0].length : 0);
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const value = m[3] ?? m[4] ?? m[2] ?? "";
    attrs[m[1].toLowerCase()] = decodeEntities(value);
  }
  return { tag, attrs, selfClosing };
}

/** Index of the '>' closing the tag at `from`, honouring quotes; -1 if none. */
function scanTagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function skipThrough(html: string, from: number, marker: string): number {
  const at = html.indexOf(marker, from);
  return at < 0 ? html.length : at + marker.length;
}

function find(root: ElementNode, tag: string): ElementNode | null {
  for (const child of root.children) {
    if (isElement(child)) {
      if (child.tag === tag) return child;
      const deep = find(child, tag);
      if (deep) return deep;
    }
  }
  return null;
}

// ---- walking (jsoup walk() port) -----------------------------------------------

function walk(node: Node, out: Block[]): void {
  if (!isElement(node)) {
    const t = normalise(node.text).trim();
    if (t.length > 0) out.push({ kind: "paragraph", inlines: [{ kind: "text", text: t, bold: false, italic: false, code: false }] });
    return;
  }
  const tag = node.tag;
  if (/^h[1-6]$/.test(tag)) {
    out.push({ kind: "heading", level: Number.parseInt(tag[1], 10), inlines: inlineChildren(node) });
  } else if (tag === "p") {
    const inl = inlineChildren(node);
    if (inl.length > 0) out.push({ kind: "paragraph", inlines: inl });
  } else if (tag === "ul" || tag === "ol") {
    const items = node.children
      .filter((c): c is ElementNode => isElement(c) && c.tag === "li")
      .map((c) => inlineChildren(c))
      .filter((inl) => inl.length > 0);
    if (items.length > 0) {
      out.push(tag === "ul" ? { kind: "bulletList", items } : { kind: "orderedList", items });
    }
  } else if (tag === "table") {
    const table = tableBlock(node);
    if (table) out.push(table);
  } else if (tag === "img") {
    out.push({ kind: "image", alt: (node.attrs["alt"] ?? "").trim() });
  } else if (tag === "br") {
    // no block of its own
  } else if (node.children.length > 0) {
    for (const child of node.children) walk(child, out);
  }
}

/** Inline-level conversion: bold/italic/code/link wrapping their text. */
function inlineChildren(el: ElementNode): Inline[] {
  const out: Inline[] = [];
  const rec = (n: Node, bold: boolean, italic: boolean, code: boolean): void => {
    if (!isElement(n)) {
      const t = normalise(n.text);
      if (/\S/.test(t)) out.push({ kind: "text", text: t, bold, italic, code });
      return;
    }
    switch (n.tag) {
      case "b":
      case "strong":
        for (const c of n.children) rec(c, true, italic, code);
        break;
      case "i":
      case "em":
        for (const c of n.children) rec(c, bold, true, code);
        break;
      case "code":
      case "kbd":
      case "samp":
        for (const c of n.children) rec(c, bold, italic, true);
        break;
      case "a": {
        const href = (n.attrs["href"] ?? "").trim();
        const label = elementText(n);
        if (href.length > 0 && label.length > 0) out.push({ kind: "link", text: label, url: href });
        else if (label.length > 0) out.push({ kind: "text", text: label, bold, italic, code });
        break;
      }
      case "br":
        out.push({ kind: "text", text: " ", bold: false, italic: false, code: false });
        break;
      default:
        for (const c of n.children) rec(c, bold, italic, code);
        break;
    }
  };
  for (const child of el.children) rec(child, false, false, false);
  const merged = mergeAdjacent(out);
  // Trim edge whitespace the collapsing introduced.
  return merged
    .map((inl, i) => {
      if (inl.kind !== "text") return inl;
      let t = inl.text;
      if (i === 0) t = t.trimStart();
      if (i === merged.length - 1) t = t.trimEnd();
      return t.length === 0 ? null : { ...inl, text: t };
    })
    .filter((inl): inl is Inline => inl !== null);
}

/** Jsoup Element.text(): descendant text, whitespace collapsed, trimmed. */
function elementText(el: ElementNode): string {
  let out = "";
  const rec = (n: Node): void => {
    if (!isElement(n)) {
      out += n.text + " ";
      return;
    }
    if (n.tag === "br") out += " ";
    for (const c of n.children) rec(c);
  };
  for (const c of el.children) rec(c);
  return normalise(out).trim();
}

function normalise(s: string): string {
  // Kotlin \s ([ \t\n\x0B\f\r]) — deliberately NOT JS \s, which would also
  // collapse the decoded &nbsp; that jsoup keeps.
  return s.replace(/[\t\n\u000B\f\r ]+/g, " ");
}

/** All descendant tr rows; each row's th/td cells become inline lists. */
function tableBlock(table: ElementNode): Block | null {
  const rows: Inline[][][] = [];
  const collect = (el: ElementNode): void => {
    for (const child of el.children) {
      if (!isElement(child)) continue;
      if (child.tag === "tr") {
        const cells = descendants(child)
          .filter((c) => c.tag === "th" || c.tag === "td")
          .map((c) => inlineChildren(c));
        if (cells.length > 0) rows.push(cells);
      } else if (child.tag !== "table") {
        collect(child); // thead/tbody/…; nested tables flatten (jsoup select("tr"))
      }
    }
  };
  collect(table);
  if (rows.length === 0) return null;
  return { kind: "table", rows };
}

function descendants(el: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  for (const child of el.children) {
    if (isElement(child)) {
      out.push(child);
      out.push(...descendants(child));
    }
  }
  return out;
}

function mergeAdjacent(inl: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const i of inl) {
    const last = out[out.length - 1];
    if (
      last && last.kind === "text" && i.kind === "text" &&
      last.bold === i.bold && last.italic === i.italic && last.code === i.code
    ) {
      out[out.length - 1] = { ...last, text: last.text + i.text };
    } else {
      out.push(i);
    }
  }
  return out;
}

function mergeLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.kind === "bulletList" && b.kind === "bulletList") {
      out[out.length - 1] = { kind: "bulletList", items: [...last.items, ...b.items] };
    } else if (last && last.kind === "orderedList" && b.kind === "orderedList") {
      out[out.length - 1] = { kind: "orderedList", items: [...last.items, ...b.items] };
    } else {
      out.push(b);
    }
  }
  return out;
}
